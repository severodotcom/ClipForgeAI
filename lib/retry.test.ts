import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retryVideo, retryClip } from "@/lib/retry";
import { getPeriodStart, getUsageThisPeriod, recordUsage } from "@/lib/usage";

// lib/transcription.ts e lib/clips.ts (chamados fire-and-forget pelo
// retry) dependem de arquivo real em disco (ffmpeg/Whisper) — fora do
// escopo destes testes, que verificam apenas a decisão de retry em si:
// ownership, transição de status (CAS) e quota. Os vídeos/clipes de teste
// não têm storagePath real, então a chamada fire-and-forget para
// transcribeVideo/generateClip vai falhar internamente (ela mesma trata o
// próprio erro e marca FAILED de novo) — isso roda depois que o teste já
// fez suas asserções sobre o retorno síncrono de retryVideo/retryClip, e
// não é aguardado por eles (é fire-and-forget também na produção).
describe("retryVideo / retryClip (lib/retry.ts)", () => {
  const runId = randomUUID();
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `retry-test-${runId}@clipforge.test`, name: "Retry Test User" },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: { email: `retry-test-other-${runId}@clipforge.test`, name: "Other User" },
    });
    otherUserId = otherUser.id;

    const project = await prisma.project.create({
      data: { userId, name: "Projeto teste de retry" },
    });
    projectId = project.id;

    const otherProject = await prisma.project.create({
      data: { userId: otherUserId, name: "Projeto de outro usuário" },
    });
    otherProjectId = otherProject.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.user.delete({ where: { id: otherUserId } });
  });

  async function createVideo(status: "FAILED" | "COMPLETED" | "TRANSCRIBING", opts: {
    storagePath?: string | null;
    duration?: number | null;
    filename?: string;
  } = {}) {
    return prisma.video.create({
      data: {
        projectId,
        originalFilename: opts.filename ?? "video.mp4",
        status,
        // `?? ` trataria `storagePath: null`/`duration: null` explícitos
        // como "ausente" e cairia no fallback — errado para o teste que
        // precisa exatamente desses campos nulos. Só usa o default quando a
        // chave não foi passada. Default storagePath é null (não um path
        // fake): retryClip dispara generateClip de verdade em fire-and-forget
        // quando o outcome é "started", e generateClip cria o diretório de
        // saída (prepareClipOutputPath) antes mesmo de o ffmpeg falhar por
        // arquivo inexistente — um path fake deixaria diretórios vazios reais
        // em storage/clips/ a cada execução da suíte. Com storagePath null,
        // generateClip retorna cedo (`!clip.video.storagePath`) sem tocar o
        // disco. Só os testes de retry de vídeo (que exigem storagePath para
        // sequer chegar a "started") passam um valor explícito.
        storagePath: "storagePath" in opts ? opts.storagePath : null,
        duration: "duration" in opts ? opts.duration : 60,
      },
    });
  }

  async function createClip(videoId: string, status: "FAILED" | "COMPLETED" | "GENERATING") {
    return prisma.clip.create({
      data: { videoId, startTime: 0, endTime: 10, status },
    });
  }

  it("1. retry de vídeo FAILED (com storagePath/duration) funciona: transiciona para TRANSCRIBING", async () => {
    const video = await createVideo("FAILED", { storagePath: "videos/fake.mp4" });

    const result = await retryVideo(projectId, video.id, userId);

    expect(result.outcome).toBe("started");
    if (result.outcome === "started") {
      expect(result.video.status).toBe("TRANSCRIBING");
    }
  });

  it("2. retry de clip FAILED funciona: transiciona para GENERATING", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await createClip(video.id, "FAILED");

    const result = await retryClip(projectId, video.id, clip.id, userId);

    expect(result.outcome).toBe("started");
    if (result.outcome === "started") {
      expect(result.clip.status).toBe("GENERATING");
    }
  });

  // P2h: decisão explícita de limpar errorMessage ao iniciar um novo
  // processamento — asserta sobre o objeto retornado por retryVideo/
  // retryClip (lido pela própria função ANTES de disparar
  // transcribeVideo/generateClip em fire-and-forget), não por uma query
  // própria depois, para não competir com o job de background que o
  // comentário no topo deste arquivo já documenta como não determinístico.
  it("1b. retry de vídeo limpa o errorMessage da falha anterior ao reiniciar o processamento", async () => {
    const video = await prisma.video.create({
      data: {
        projectId,
        originalFilename: "video.mp4",
        status: "FAILED",
        storagePath: "videos/fake.mp4",
        duration: 60,
        errorMessage: "erro simulado da tentativa anterior",
      },
    });

    const result = await retryVideo(projectId, video.id, userId);

    expect(result.outcome).toBe("started");
    if (result.outcome === "started") {
      expect(result.video.errorMessage).toBeNull();
    }
  });

  it("2b. retry de clip limpa o errorMessage da falha anterior ao reiniciar o processamento", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await prisma.clip.create({
      data: {
        videoId: video.id,
        startTime: 0,
        endTime: 10,
        status: "FAILED",
        errorMessage: "erro simulado da tentativa anterior",
      },
    });

    const result = await retryClip(projectId, video.id, clip.id, userId);

    expect(result.outcome).toBe("started");
    if (result.outcome === "started") {
      expect(result.clip.errorMessage).toBeNull();
    }
  });

  it("3. retry de vídeo COMPLETED é rejeitado (not_failed), status não muda", async () => {
    const video = await createVideo("COMPLETED");

    const result = await retryVideo(projectId, video.id, userId);

    expect(result.outcome).toBe("not_failed");

    const stillCompleted = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(stillCompleted.status).toBe("COMPLETED");
  });

  it("3b. retry de clip COMPLETED é rejeitado (not_failed), status não muda", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await createClip(video.id, "COMPLETED");

    const result = await retryClip(projectId, video.id, clip.id, userId);

    expect(result.outcome).toBe("not_failed");

    const stillCompleted = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
    expect(stillCompleted.status).toBe("COMPLETED");
  });

  it("4. retry de vídeo ainda em processamento (TRANSCRIBING) é rejeitado", async () => {
    const video = await createVideo("TRANSCRIBING");

    const result = await retryVideo(projectId, video.id, userId);

    expect(result.outcome).toBe("not_failed");

    const stillTranscribing = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(stillTranscribing.status).toBe("TRANSCRIBING");
  });

  it("4b. retry de clip ainda em processamento (GENERATING) é rejeitado", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await createClip(video.id, "GENERATING");

    const result = await retryClip(projectId, video.id, clip.id, userId);

    expect(result.outcome).toBe("not_failed");

    const stillGenerating = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
    expect(stillGenerating.status).toBe("GENERATING");
  });

  it("5. usuário sem ownership é rejeitado (not_found) — vídeo de outro usuário", async () => {
    const video = await createVideo("FAILED");

    const result = await retryVideo(otherProjectId, video.id, otherUserId);

    expect(result.outcome).toBe("not_found");

    const unchanged = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(unchanged.status).toBe("FAILED");
  });

  it("5b. usuário sem ownership é rejeitado (not_found) — clip de outro usuário", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await createClip(video.id, "FAILED");

    const result = await retryClip(otherProjectId, video.id, clip.id, otherUserId);

    expect(result.outcome).toBe("not_found");

    const unchanged = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
    expect(unchanged.status).toBe("FAILED");
  });

  it("6. retry de vídeo não duplica UsageRecord de TRANSCRIPTION_MINUTES", async () => {
    const video = await createVideo("FAILED", { storagePath: "videos/fake.mp4", duration: 120 });

    // Simula a reserva original de minutos feita no upload, antes do vídeo
    // ter falhado.
    await recordUsage({
      userId,
      type: UsageType.TRANSCRIPTION_MINUTES,
      amount: 2,
      periodStart: getPeriodStart(),
      idempotencyKey: `TRANSCRIPTION_MINUTES:${video.id}`,
      videoId: video.id,
    });

    const usageBefore = await getUsageThisPeriod(userId);

    const result = await retryVideo(projectId, video.id, userId);
    expect(result.outcome).toBe("started");

    const usageAfter = await getUsageThisPeriod(userId);
    expect(usageAfter.minutes).toBe(usageBefore.minutes);

    const records = await prisma.usageRecord.count({
      where: { idempotencyKey: `TRANSCRIPTION_MINUTES:${video.id}` },
    });
    expect(records).toBe(1);
  });

  it("6b. retry de clip não duplica UsageRecord de CLIP_GENERATED", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await createClip(video.id, "FAILED");

    await recordUsage({
      userId,
      type: UsageType.CLIP_GENERATED,
      amount: 1,
      periodStart: getPeriodStart(),
      idempotencyKey: `CLIP_GENERATED:${clip.id}`,
      videoId: video.id,
      clipId: clip.id,
    });

    const usageBefore = await getUsageThisPeriod(userId);

    const result = await retryClip(projectId, video.id, clip.id, userId);
    expect(result.outcome).toBe("started");

    const usageAfter = await getUsageThisPeriod(userId);
    expect(usageAfter.clips).toBe(usageBefore.clips);

    const records = await prisma.usageRecord.count({
      where: { idempotencyKey: `CLIP_GENERATED:${clip.id}` },
    });
    expect(records).toBe(1);
  });

  it("7. dois retries concorrentes do mesmo vídeo: só um inicia, o outro é rejeitado", async () => {
    const video = await createVideo("FAILED", { storagePath: "videos/fake.mp4" });

    const [first, second] = await Promise.all([
      retryVideo(projectId, video.id, userId),
      retryVideo(projectId, video.id, userId),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["not_failed", "started"]);
  });

  it("7b. dois retries concorrentes do mesmo clip: só um inicia, o outro é rejeitado", async () => {
    const video = await createVideo("COMPLETED");
    const clip = await createClip(video.id, "FAILED");

    const [first, second] = await Promise.all([
      retryClip(projectId, video.id, clip.id, userId),
      retryClip(projectId, video.id, clip.id, userId),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["not_failed", "started"]);
  });

  it("retry de vídeo FAILED sem storagePath/duration (falhou antes do upload terminar) é rejeitado", async () => {
    const video = await createVideo("FAILED", { storagePath: null, duration: null });

    const result = await retryVideo(projectId, video.id, userId);

    expect(result.outcome).toBe("missing_upload_data");

    const unchanged = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(unchanged.status).toBe("FAILED");
  });
});
