import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  checkQuota,
  evaluateQuota,
  getPeriodStart,
  getUsageThisPeriod,
  getUserPlan,
  lockUserForQuota,
  recordUsage,
} from "./usage";

describe("getPeriodStart", () => {
  it("retorna o início do mês em UTC, ignorando timezone local", () => {
    expect(getPeriodStart(new Date("2026-08-21T15:30:00.000Z"))).toEqual(
      new Date("2026-08-01T00:00:00.000Z")
    );
  });

  it("já normaliza uma data que é o próprio primeiro dia do mês", () => {
    expect(getPeriodStart(new Date("2026-01-01T23:59:59.000Z"))).toEqual(
      new Date("2026-01-01T00:00:00.000Z")
    );
  });

  it("lida corretamente com o último dia do mês (dezembro -> janeiro do ano seguinte não vaza)", () => {
    expect(getPeriodStart(new Date("2026-12-31T23:59:59.000Z"))).toEqual(
      new Date("2026-12-01T00:00:00.000Z")
    );
  });
});

describe("evaluateQuota", () => {
  it("permite consumo abaixo do limite", () => {
    expect(evaluateQuota(5, 10, 1)).toEqual({ allowed: true, remaining: 5 });
  });

  it("permite consumo que preenche exatamente o limite", () => {
    expect(evaluateQuota(9, 10, 1)).toEqual({ allowed: true, remaining: 1 });
  });

  it("rejeita consumo que ultrapassaria o limite", () => {
    // used=25, limit=30, additionalAmount=10 -> 35 > 30
    expect(evaluateQuota(25, 30, 10)).toEqual({ allowed: false, remaining: 5 });
  });

  it("remaining nunca é negativo, mesmo já tendo estourado o limite", () => {
    expect(evaluateQuota(50, 30, 1)).toEqual({ allowed: false, remaining: 0 });
  });
});

/**
 * Testes de integração contra o banco de desenvolvimento já configurado no
 * projeto (DATABASE_URL, via .env) — não há mock de Prisma nesta base de
 * código. Usa um usuário efêmero dedicado (email aleatório) para não tocar
 * em nenhum dado real/existente; removido no afterAll via cascade delete.
 * Chaves de idempotência incluem um runId aleatório para nunca colidir
 * entre execuções, mesmo que um afterAll anterior tenha falhado.
 */
describe("lib/usage.ts (integração com o banco de desenvolvimento)", () => {
  const runId = randomUUID();
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `usage-test-${runId}@clipforge.test`,
        name: "Usage Test User",
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // UsageRecord e Subscription têm onDelete: Cascade a partir de User.
    await prisma.user.delete({ where: { id: userId } });
  });

  it("usa o plano free quando o usuário não possui Subscription", async () => {
    const plan = await getUserPlan(userId);

    expect(plan.key).toBe("free");
    expect(plan.maxVideosPerMonth).toBeGreaterThan(0);
  });

  it("usage vazio retorna zeros em todos os contadores", async () => {
    const usage = await getUsageThisPeriod(userId);

    expect(usage).toEqual({ videos: 0, minutes: 0, aiAnalyses: 0, clips: 0 });
  });

  it("agrega usage acumulado e mapeia cada UsageType para o contador correto", async () => {
    const periodStart = getPeriodStart();

    await recordUsage({
      userId,
      type: UsageType.VIDEO_UPLOAD,
      amount: 1,
      periodStart,
      idempotencyKey: `TEST:${runId}:VIDEO_UPLOAD:v1`,
      videoId: "video-1",
    });
    await recordUsage({
      userId,
      type: UsageType.TRANSCRIPTION_MINUTES,
      amount: 15,
      periodStart,
      idempotencyKey: `TEST:${runId}:TRANSCRIPTION_MINUTES:v1`,
      videoId: "video-1",
    });
    await recordUsage({
      userId,
      type: UsageType.AI_ANALYSIS,
      amount: 1,
      periodStart,
      idempotencyKey: `TEST:${runId}:AI_ANALYSIS:c1`,
      analysisCacheId: "cache-1",
      promptTokens: 717,
      completionTokens: 147,
      totalTokens: 864,
    });
    await recordUsage({
      userId,
      type: UsageType.CLIP_GENERATED,
      amount: 1,
      periodStart,
      idempotencyKey: `TEST:${runId}:CLIP_GENERATED:clip1`,
      clipId: "clip-1",
    });
    // Um segundo vídeo/clipe para confirmar que amounts do mesmo tipo somam.
    await recordUsage({
      userId,
      type: UsageType.VIDEO_UPLOAD,
      amount: 1,
      periodStart,
      idempotencyKey: `TEST:${runId}:VIDEO_UPLOAD:v2`,
      videoId: "video-2",
    });

    const usage = await getUsageThisPeriod(userId);

    expect(usage).toEqual({ videos: 2, minutes: 15, aiAnalyses: 1, clips: 1 });
  });

  it("checkQuota permite consumo abaixo do limite do plano free", async () => {
    // Estado herdado do teste anterior: 2 videos, 15 minutos, 1 análise, 1 clip.
    const result = await checkQuota(userId, UsageType.VIDEO_UPLOAD, 1);

    expect(result.type).toBe(UsageType.VIDEO_UPLOAD);
    expect(result.used).toBe(2);
    expect(result.limit).toBe(3); // limite provisório do plano free seedado
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("checkQuota rejeita consumo que ultrapassaria o limite do plano free", async () => {
    // 15 minutos já usados, limite free = 30 -> pedir mais 20 estoura.
    const result = await checkQuota(userId, UsageType.TRANSCRIPTION_MINUTES, 20);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(15);
  });

  it("recordUsage preserva a idempotencyKey no registro criado", async () => {
    const idempotencyKey = `TEST:${runId}:CLIP_GENERATED:clip-preserve`;

    await recordUsage({
      userId,
      type: UsageType.CLIP_GENERATED,
      amount: 1,
      periodStart: getPeriodStart(),
      idempotencyKey,
      clipId: "clip-preserve",
    });

    const row = await prisma.usageRecord.findUnique({ where: { idempotencyKey } });

    expect(row).not.toBeNull();
    expect(row?.idempotencyKey).toBe(idempotencyKey);
    expect(row?.clipId).toBe("clip-preserve");
  });

  it("recordUsage não cria uma segunda linha para a mesma idempotencyKey", async () => {
    const idempotencyKey = `TEST:${runId}:AI_ANALYSIS:dup-check`;
    const params = {
      userId,
      type: UsageType.AI_ANALYSIS,
      amount: 1,
      periodStart: getPeriodStart(),
      idempotencyKey,
      analysisCacheId: "cache-dup",
    };

    await recordUsage(params);
    await recordUsage(params); // retry simulado — mesma chave
    await recordUsage(params); // retry simulado de novo

    const rows = await prisma.usageRecord.findMany({ where: { idempotencyKey } });

    expect(rows).toHaveLength(1);
  });
});

class QuotaExceededTestError extends Error {
  constructor(public readonly quota: Awaited<ReturnType<typeof checkQuota>>) {
    super("QUOTA_EXCEEDED");
  }
}

/**
 * Replica, campo a campo, o corpo da transação usada em
 * app/api/projects/[id]/videos/route.ts (lock -> checkQuota -> create Video
 * -> recordUsage, tudo dentro de um único prisma.$transaction). Não
 * importamos o módulo da rota diretamente porque ele usa `headers()` de
 * `next/headers`, que só funciona dentro do runtime real de uma request do
 * Next.js — fora dele (como aqui, em vitest) lança erro por falta de
 * request scope. A verificação HTTP de ponta a ponta (sessão real, upload
 * real) é feita manualmente no navegador, descrita no relatório final.
 */
async function reserveVideoUpload(userId: string, projectId: string, originalFilename: string) {
  return prisma.$transaction(async (tx) => {
    await lockUserForQuota(userId, tx);

    const quota = await checkQuota(userId, UsageType.VIDEO_UPLOAD, 1, tx);

    if (!quota.allowed) {
      throw new QuotaExceededTestError(quota);
    }

    const video = await tx.video.create({
      data: { projectId, originalFilename, status: "UPLOADING" },
    });

    await recordUsage(
      {
        userId,
        type: UsageType.VIDEO_UPLOAD,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey: `VIDEO_UPLOAD:${video.id}`,
        videoId: video.id,
      },
      tx
    );

    return video;
  });
}

describe("reserva de quota VIDEO_UPLOAD (mesma lógica usada pela rota de upload)", () => {
  const runId = randomUUID();
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `usage-video-test-${runId}@clipforge.test`, name: "Usage Video Test User" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { userId, name: "Projeto de teste de quota" },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    // Video -> Project -> User e UsageRecord -> User têm onDelete: Cascade.
    await prisma.user.delete({ where: { id: userId } });
  });

  it("usuário free com 0 vídeos: upload é permitido", async () => {
    const video = await reserveVideoUpload(userId, projectId, "video-0.mp4");

    expect(video.status).toBe("UPLOADING");

    const usage = await getUsageThisPeriod(userId);
    expect(usage.videos).toBe(1);
  });

  it("usuário free com 2 vídeos: terceiro é permitido (limite free = 3)", async () => {
    // já tem 1 do teste anterior; sobe para 2 antes de testar o 3º.
    await reserveVideoUpload(userId, projectId, "video-1.mp4");

    const usageBefore = await getUsageThisPeriod(userId);
    expect(usageBefore.videos).toBe(2);

    const video = await reserveVideoUpload(userId, projectId, "video-2.mp4");
    expect(video.status).toBe("UPLOADING");

    const usageAfter = await getUsageThisPeriod(userId);
    expect(usageAfter.videos).toBe(3);
  });

  it("usuário free com 3 vídeos: próximo upload é rejeitado", async () => {
    await expect(reserveVideoUpload(userId, projectId, "video-3.mp4")).rejects.toThrow(
      "QUOTA_EXCEEDED"
    );
  });

  it("upload rejeitado não cria Video nem UsageRecord novos", async () => {
    const videosBefore = await prisma.video.count({ where: { projectId } });
    const usageRecordsBefore = await prisma.usageRecord.count({
      where: { userId, type: UsageType.VIDEO_UPLOAD },
    });

    await expect(reserveVideoUpload(userId, projectId, "video-should-not-exist.mp4")).rejects.toThrow(
      "QUOTA_EXCEEDED"
    );

    const videosAfter = await prisma.video.count({ where: { projectId } });
    const usageRecordsAfter = await prisma.usageRecord.count({
      where: { userId, type: UsageType.VIDEO_UPLOAD },
    });

    expect(videosAfter).toBe(videosBefore);
    expect(usageRecordsAfter).toBe(usageRecordsBefore);
    expect(
      prisma.video.findFirst({ where: { originalFilename: "video-should-not-exist.mp4" } })
    ).resolves.toBeNull();
  });

  it("upload bem-sucedido cria exatamente 1 UsageRecord com videoId e idempotencyKey corretos", async () => {
    // usuário já está no limite (3/3) nesta suíte — usamos um usuário à
    // parte, limpo, só para isolar esta asserção de "exatamente 1 linha".
    const soloUser = await prisma.user.create({
      data: { email: `usage-video-solo-${runId}@clipforge.test`, name: "Solo" },
    });
    const soloProject = await prisma.project.create({
      data: { userId: soloUser.id, name: "Projeto solo" },
    });

    try {
      const video = await reserveVideoUpload(soloUser.id, soloProject.id, "solo.mp4");

      const records = await prisma.usageRecord.findMany({
        where: { userId: soloUser.id, type: UsageType.VIDEO_UPLOAD },
      });

      expect(records).toHaveLength(1);
      expect(records[0].videoId).toBe(video.id);
      expect(records[0].idempotencyKey).toBe(`VIDEO_UPLOAD:${video.id}`);
    } finally {
      await prisma.user.delete({ where: { id: soloUser.id } });
    }
  });

  it("repetir recordUsage para o mesmo vídeo não duplica o UsageRecord", async () => {
    const soloUser = await prisma.user.create({
      data: { email: `usage-video-retry-${runId}@clipforge.test`, name: "Retry" },
    });
    const soloProject = await prisma.project.create({
      data: { userId: soloUser.id, name: "Projeto retry" },
    });

    try {
      const video = await reserveVideoUpload(soloUser.id, soloProject.id, "retry.mp4");
      const idempotencyKey = `VIDEO_UPLOAD:${video.id}`;

      // Simula um retry da mesma requisição chamando recordUsage de novo,
      // fora de transação, com a mesma chave.
      await recordUsage({
        userId: soloUser.id,
        type: UsageType.VIDEO_UPLOAD,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey,
        videoId: video.id,
      });
      await recordUsage({
        userId: soloUser.id,
        type: UsageType.VIDEO_UPLOAD,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey,
        videoId: video.id,
      });

      const records = await prisma.usageRecord.findMany({ where: { idempotencyKey } });
      expect(records).toHaveLength(1);
    } finally {
      await prisma.user.delete({ where: { id: soloUser.id } });
    }
  });

  it("duas requisições concorrentes não ultrapassam a quota (lock via SELECT ... FOR UPDATE)", async () => {
    const concurrentUser = await prisma.user.create({
      data: { email: `usage-video-concurrent-${runId}@clipforge.test`, name: "Concurrent" },
    });
    const concurrentProject = await prisma.project.create({
      data: { userId: concurrentUser.id, name: "Projeto concorrência" },
    });

    try {
      // Deixa o usuário com 2/3 vídeos usados, sequencialmente.
      await reserveVideoUpload(concurrentUser.id, concurrentProject.id, "c-0.mp4");
      await reserveVideoUpload(concurrentUser.id, concurrentProject.id, "c-1.mp4");

      const usageBefore = await getUsageThisPeriod(concurrentUser.id);
      expect(usageBefore.videos).toBe(2);

      // Duas requisições disputando a última vaga (limite = 3) ao mesmo tempo.
      const results = await Promise.allSettled([
        reserveVideoUpload(concurrentUser.id, concurrentProject.id, "c-race-a.mp4"),
        reserveVideoUpload(concurrentUser.id, concurrentProject.id, "c-race-b.mp4"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (rejected[0]?.status === "rejected") {
        expect((rejected[0].reason as Error).message).toBe("QUOTA_EXCEEDED");
      }

      const finalVideoCount = await prisma.video.count({ where: { projectId: concurrentProject.id } });
      const finalUsage = await getUsageThisPeriod(concurrentUser.id);

      expect(finalVideoCount).toBe(3);
      expect(finalUsage.videos).toBe(3);
    } finally {
      await prisma.user.delete({ where: { id: concurrentUser.id } });
    }
  });
});
