import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAudioDuration } from "@/lib/ffmpeg";
import { getVideoAbsolutePath } from "@/lib/storage";
import { transcribeVideo } from "@/lib/transcription";
import {
  checkQuota,
  getPeriodStart,
  getUsageThisPeriod,
  lockUserForQuota,
  recordUsage,
} from "@/lib/usage";

const execFileAsync = promisify(execFile);

/**
 * Réplica, campo a campo, do trecho de app/api/projects/[id]/videos/route.ts
 * que fica *depois* de checkQuota/getUserPlan (a reserva em si): trava a
 * linha do User, reconta TRANSCRIPTION_MINUTES dentro da transação, e só
 * grava o Video como UPLOADED + registra o UsageRecord se couber — do
 * contrário marca QUOTA_EXCEEDED sem gravar nada em UsageRecord. Extraída
 * separada de processDurationAndMinutesQuota (que roda o ffprobe) para que
 * o teste de concorrência possa reservar minutos com uma duração sintética,
 * sem precisar de um arquivo de vídeo real por chamada.
 */
async function reserveTranscriptionMinutes(
  userId: string,
  videoId: string,
  duration: number,
  minutes: number
) {
  return prisma.$transaction(async (tx) => {
    await lockUserForQuota(userId, tx);

    const quota = await checkQuota(userId, UsageType.TRANSCRIPTION_MINUTES, minutes, tx);

    if (!quota.allowed) {
      return tx.video.update({
        where: { id: videoId },
        data: { duration, status: "QUOTA_EXCEEDED" },
      });
    }

    const updated = await tx.video.update({
      where: { id: videoId },
      data: { duration, status: "UPLOADED" },
    });

    await recordUsage(
      {
        userId,
        type: UsageType.TRANSCRIPTION_MINUTES,
        amount: minutes,
        periodStart: getPeriodStart(),
        idempotencyKey: `TRANSCRIPTION_MINUTES:${videoId}`,
        videoId,
      },
      tx
    );

    return updated;
  });
}

/**
 * Réplica completa da orquestração da rota: ffprobe primeiro (fora de
 * qualquer transação — mesma ordem do código real), FAILED se a duração não
 * puder ser determinada, senão delega a reserva em si para
 * reserveTranscriptionMinutes. Não importamos o módulo da rota diretamente
 * pelo mesmo motivo documentado em lib/usage.test.ts: ele usa `headers()` de
 * `next/headers`, que só funciona dentro do runtime real de uma request do
 * Next.js.
 */
async function processDurationAndMinutesQuota(userId: string, videoId: string, filePath: string) {
  let duration: number;
  try {
    duration = await getAudioDuration(filePath);
  } catch {
    return prisma.video.update({ where: { id: videoId }, data: { status: "FAILED" } });
  }

  const minutes = Math.ceil(duration / 60);
  return reserveTranscriptionMinutes(userId, videoId, duration, minutes);
}

const FIXTURE_DIR = path.join(os.tmpdir(), `clipforge-usage-minutes-test-${randomUUID()}`);
let shortVideoPath: string;
let longVideoPath: string;
let corruptedVideoPath: string;

beforeAll(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });

  shortVideoPath = path.join(FIXTURE_DIR, "short.mp4");
  longVideoPath = path.join(FIXTURE_DIR, "long.mp4");
  corruptedVideoPath = path.join(FIXTURE_DIR, "corrupted.mp4");

  // ~1s — cabe folgadamente no limite de 30 min/mês do plano free.
  await execFileAsync("ffmpeg", [
    "-f", "lavfi", "-i", "color=c=blue:s=64x48:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac", "-shortest", "-y", shortVideoPath,
  ]);

  // 40 min (2400s) — maior que o limite de 30 min/mês do plano free.
  // Resolução/bitrate mínimos para manter o arquivo pequeno e o encode rápido.
  await execFileAsync("ffmpeg", [
    "-f", "lavfi", "-i", "color=c=red:s=64x48:r=1:d=2400",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2400",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "51",
    "-c:a", "aac", "-b:a", "8k", "-shortest", "-y", longVideoPath,
  ]);

  await writeFile(corruptedVideoPath, "isto nao e um video valido, apenas texto");
}, 30000);

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

describe("orquestração de TRANSCRIPTION_MINUTES (mesma lógica usada pela rota de upload)", () => {
  const runId = randomUUID();
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `usage-minutes-test-${runId}@clipforge.test`, name: "Usage Minutes Test User" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { userId, name: "Projeto de teste de minutos" },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    // Video/UsageRecord -> User têm onDelete: Cascade só para Video (via
    // Project); UsageRecord.videoId NÃO tem FK/cascade (é um ledger
    // imutável, de propósito) — por isso o cascade de User cobre
    // UsageRecord.userId diretamente, e é isso que limpa tudo aqui.
    await prisma.user.delete({ where: { id: userId } });
    await rm(getVideoAbsolutePath(projectId), { recursive: true, force: true });
  });

  async function createVideoWithFixture(originalFilename: string, fixturePath: string) {
    const video = await prisma.video.create({
      data: { projectId, originalFilename, status: "UPLOADING" },
    });

    const storagePath = path.join(projectId, `${video.id}-${originalFilename}`);
    const absolutePath = getVideoAbsolutePath(storagePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await copyFile(fixturePath, absolutePath);

    await prisma.video.update({ where: { id: video.id }, data: { storagePath } });

    return { video, absolutePath };
  }

  it("ffprobe dentro da quota: vídeo aceito, minutos reservados", async () => {
    const { video, absolutePath } = await createVideoWithFixture("short.mp4", shortVideoPath);

    const result = await processDurationAndMinutesQuota(userId, video.id, absolutePath);

    expect(result.status).toBe("UPLOADED");
    expect(result.duration).toBeCloseTo(1, 0);

    const usage = await getUsageThisPeriod(userId);
    expect(usage.minutes).toBe(1); // Math.ceil(1/60)
  }, 15000);

  it("ffprobe acima da quota: vídeo fica QUOTA_EXCEEDED, minutos NÃO são reservados", async () => {
    const { video, absolutePath } = await createVideoWithFixture("long.mp4", longVideoPath);

    const result = await processDurationAndMinutesQuota(userId, video.id, absolutePath);

    expect(result.status).toBe("QUOTA_EXCEEDED");
    expect(result.duration).toBeGreaterThan(30 * 60);

    const record = await prisma.usageRecord.findUnique({
      where: { idempotencyKey: `TRANSCRIPTION_MINUTES:${video.id}` },
    });
    expect(record).toBeNull();
  }, 15000);

  it("QUOTA_EXCEEDED nunca dispara transcribeVideo (nenhuma Transcription é criada)", async () => {
    const { video, absolutePath } = await createVideoWithFixture("long-2.mp4", longVideoPath);

    const result = await processDurationAndMinutesQuota(userId, video.id, absolutePath);
    expect(result.status).toBe("QUOTA_EXCEEDED");

    // Mesma condição usada na rota real para decidir se chama transcribeVideo.
    const shouldTranscribe = result.status === "UPLOADED";
    expect(shouldTranscribe).toBe(false);

    const transcription = await prisma.transcription.findUnique({ where: { videoId: video.id } });
    expect(transcription).toBeNull();
  }, 15000);

  it("ffprobe não consegue determinar a duração: vídeo fica FAILED, minutos NÃO são reservados", async () => {
    const { video, absolutePath } = await createVideoWithFixture("corrupted.mp4", corruptedVideoPath);

    const result = await processDurationAndMinutesQuota(userId, video.id, absolutePath);

    expect(result.status).toBe("FAILED");
    expect(result.duration).toBeNull();

    const record = await prisma.usageRecord.findUnique({
      where: { idempotencyKey: `TRANSCRIPTION_MINUTES:${video.id}` },
    });
    expect(record).toBeNull();
  }, 15000);

  it(
    "transcrição bem-sucedida: exatamente 1 UsageRecord de TRANSCRIPTION_MINUTES, Transcription criada",
    async () => {
      const { video, absolutePath } = await createVideoWithFixture("short-real.mp4", shortVideoPath);

      const reserved = await processDurationAndMinutesQuota(userId, video.id, absolutePath);
      expect(reserved.status).toBe("UPLOADED");

      await transcribeVideo(video.id);

      const finalVideo = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
      expect(finalVideo.status).toBe("UPLOADED");

      const transcription = await prisma.transcription.findUnique({ where: { videoId: video.id } });
      expect(transcription).not.toBeNull();

      const records = await prisma.usageRecord.findMany({
        where: { videoId: video.id, type: UsageType.TRANSCRIPTION_MINUTES },
      });
      expect(records).toHaveLength(1);
    },
    45000
  );

  it(
    "falha após a reserva (equivalente a uma falha do Whisper): minutos permanecem reservados",
    async () => {
      const { video, absolutePath } = await createVideoWithFixture("will-fail.mp4", shortVideoPath);

      const reserved = await processDurationAndMinutesQuota(userId, video.id, absolutePath);
      expect(reserved.status).toBe("UPLOADED");

      const recordsBefore = await prisma.usageRecord.findMany({
        where: { videoId: video.id, type: UsageType.TRANSCRIPTION_MINUTES },
      });
      expect(recordsBefore).toHaveLength(1);

      // Corrompe o arquivo já reservado para forçar extractAudioWav (ffmpeg)
      // a falhar dentro de transcribeVideo — mesmo bloco catch que uma
      // falha real do Whisper acionaria (lib/transcription.ts), sem
      // precisar mockar o modelo de ML.
      await writeFile(absolutePath, "arquivo corrompido depois da reserva de quota");

      await transcribeVideo(video.id);

      const finalVideo = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
      expect(finalVideo.status).toBe("FAILED");

      const transcription = await prisma.transcription.findUnique({ where: { videoId: video.id } });
      expect(transcription).toBeNull();

      // Política escolhida: a reserva feita antes do processamento rodar
      // não é estornada se o processamento falhar depois.
      const recordsAfter = await prisma.usageRecord.findMany({
        where: { videoId: video.id, type: UsageType.TRANSCRIPTION_MINUTES },
      });
      expect(recordsAfter).toHaveLength(1);
      expect(recordsAfter[0].id).toBe(recordsBefore[0].id);
    },
    15000
  );

  it("concorrência perto do limite de minutos: apenas uma das duas reservas cabe", async () => {
    const concurrentUser = await prisma.user.create({
      data: { email: `usage-minutes-concurrent-${runId}@clipforge.test`, name: "Concurrent Minutes" },
    });
    const concurrentProject = await prisma.project.create({
      data: { userId: concurrentUser.id, name: "Projeto concorrência minutos" },
    });

    try {
      // Usa 25 dos 30 minutos/mês do plano free, sequencialmente.
      const seedVideo = await prisma.video.create({
        data: { projectId: concurrentProject.id, originalFilename: "seed.mp4", status: "UPLOADING" },
      });
      const seeded = await reserveTranscriptionMinutes(concurrentUser.id, seedVideo.id, 25 * 60, 25);
      expect(seeded.status).toBe("UPLOADED");

      const usageBefore = await getUsageThisPeriod(concurrentUser.id);
      expect(usageBefore.minutes).toBe(25);

      // Duas requisições de 4 minutos cada, disputando os 5 minutos restantes.
      const videoA = await prisma.video.create({
        data: { projectId: concurrentProject.id, originalFilename: "race-a.mp4", status: "UPLOADING" },
      });
      const videoB = await prisma.video.create({
        data: { projectId: concurrentProject.id, originalFilename: "race-b.mp4", status: "UPLOADING" },
      });

      const [resultA, resultB] = await Promise.all([
        reserveTranscriptionMinutes(concurrentUser.id, videoA.id, 4 * 60, 4),
        reserveTranscriptionMinutes(concurrentUser.id, videoB.id, 4 * 60, 4),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual(["QUOTA_EXCEEDED", "UPLOADED"]);

      const finalUsage = await getUsageThisPeriod(concurrentUser.id);
      // 25 + 4 apenas — nunca 25 + 4 + 4 = 33, que estouraria o limite de 30.
      expect(finalUsage.minutes).toBe(29);
    } finally {
      await prisma.user.delete({ where: { id: concurrentUser.id } });
    }
  });
});
