import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipStatus, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reconcileStuckOperations, RECONCILE_STALE_AFTER_MS } from "@/lib/reconciliation";

describe("reconcileStuckOperations (lib/reconciliation.ts)", () => {
  const runId = randomUUID();
  let userId: string;
  let projectId: string;

  // Referência de tempo fixa injetada em reconcileStuckOperations — os
  // testes não dependem do relógio real nem de sleeps.
  const NOW = new Date("2026-08-28T12:00:00.000Z");
  const STALE_CREATED_AT = new Date(NOW.getTime() - RECONCILE_STALE_AFTER_MS - 60_000); // passou do limite
  const RECENT_CREATED_AT = new Date(NOW.getTime() - 60_000); // bem dentro do limite

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `reconciliation-test-${runId}@clipforge.test`, name: "Reconciliation Test User" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { userId, name: "Projeto teste de reconciliação" },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  async function createVideo(status: VideoStatus, createdAt: Date, originalFilename: string) {
    return prisma.video.create({
      data: { projectId, originalFilename, status, createdAt },
    });
  }

  async function createClip(videoId: string, status: ClipStatus, createdAt: Date) {
    return prisma.clip.create({
      data: { videoId, startTime: 0, endTime: 10, status, createdAt },
    });
  }

  it("vídeo TRANSCRIBING travado (mais velho que o limite) -> FAILED", async () => {
    const video = await createVideo("TRANSCRIBING", STALE_CREATED_AT, "stale-transcribing.mp4");

    await reconcileStuckOperations(NOW);

    const result = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(result.status).toBe("FAILED");
  });

  it("vídeo ANALYZING travado (mais velho que o limite) -> FAILED", async () => {
    const video = await createVideo("ANALYZING", STALE_CREATED_AT, "stale-analyzing.mp4");

    await reconcileStuckOperations(NOW);

    const result = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(result.status).toBe("FAILED");
  });

  it("vídeo GENERATING travado (mais velho que o limite) -> FAILED", async () => {
    const video = await createVideo("GENERATING", STALE_CREATED_AT, "stale-generating.mp4");

    await reconcileStuckOperations(NOW);

    const result = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(result.status).toBe("FAILED");
  });

  it("clipe GENERATING travado (mais velho que o limite) -> FAILED", async () => {
    const video = await createVideo("UPLOADED", RECENT_CREATED_AT, "video-para-clipe-travado.mp4");
    const clip = await createClip(video.id, "GENERATING", STALE_CREATED_AT);

    await reconcileStuckOperations(NOW);

    const result = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
    expect(result.status).toBe("FAILED");
  });

  it("operações recentes (dentro do limite de idade) NÃO são alteradas", async () => {
    const recentTranscribing = await createVideo("TRANSCRIBING", RECENT_CREATED_AT, "recent-transcribing.mp4");
    const recentAnalyzing = await createVideo("ANALYZING", RECENT_CREATED_AT, "recent-analyzing.mp4");
    const recentGenerating = await createVideo("GENERATING", RECENT_CREATED_AT, "recent-generating.mp4");
    const videoForClip = await createVideo("UPLOADED", RECENT_CREATED_AT, "video-para-clipe-recente.mp4");
    const recentClip = await createClip(videoForClip.id, "GENERATING", RECENT_CREATED_AT);

    await reconcileStuckOperations(NOW);

    const [v1, v2, v3, c1] = await Promise.all([
      prisma.video.findUniqueOrThrow({ where: { id: recentTranscribing.id } }),
      prisma.video.findUniqueOrThrow({ where: { id: recentAnalyzing.id } }),
      prisma.video.findUniqueOrThrow({ where: { id: recentGenerating.id } }),
      prisma.clip.findUniqueOrThrow({ where: { id: recentClip.id } }),
    ]);

    expect(v1.status).toBe("TRANSCRIBING");
    expect(v2.status).toBe("ANALYZING");
    expect(v3.status).toBe("GENERATING");
    expect(c1.status).toBe("GENERATING");
  });

  it("vídeo e clipe COMPLETED nunca são alterados, mesmo muito antigos", async () => {
    const oldCompletedVideo = await createVideo("COMPLETED", STALE_CREATED_AT, "old-completed.mp4");
    const videoForCompletedClip = await createVideo("UPLOADED", STALE_CREATED_AT, "video-para-clipe-completo.mp4");
    const oldCompletedClip = await createClip(videoForCompletedClip.id, "COMPLETED", STALE_CREATED_AT);

    await reconcileStuckOperations(NOW);

    const [v, c] = await Promise.all([
      prisma.video.findUniqueOrThrow({ where: { id: oldCompletedVideo.id } }),
      prisma.clip.findUniqueOrThrow({ where: { id: oldCompletedClip.id } }),
    ]);

    expect(v.status).toBe("COMPLETED");
    expect(c.status).toBe("COMPLETED");
  });

  it("rodar a reconciliação mais de uma vez é idempotente — segunda execução não falha nem desfaz nada", async () => {
    const video = await createVideo("TRANSCRIBING", STALE_CREATED_AT, "idempotent-transcribing.mp4");
    const videoForClip = await createVideo("UPLOADED", RECENT_CREATED_AT, "video-para-clipe-idempotente.mp4");
    const clip = await createClip(videoForClip.id, "GENERATING", STALE_CREATED_AT);

    const first = await reconcileStuckOperations(NOW);
    expect(first.videosMarkedFailed).toBeGreaterThanOrEqual(1);
    expect(first.clipsMarkedFailed).toBeGreaterThanOrEqual(1);

    const [videoAfterFirst, clipAfterFirst] = await Promise.all([
      prisma.video.findUniqueOrThrow({ where: { id: video.id } }),
      prisma.clip.findUniqueOrThrow({ where: { id: clip.id } }),
    ]);
    expect(videoAfterFirst.status).toBe("FAILED");
    expect(clipAfterFirst.status).toBe("FAILED");

    // Segunda execução: as linhas já estão FAILED, não são mais candidatas
    // (não casam com o `where: status IN (...)`) — não deve haver erro nem
    // qualquer alteração adicional nelas.
    const second = await reconcileStuckOperations(NOW);

    const [videoAfterSecond, clipAfterSecond] = await Promise.all([
      prisma.video.findUniqueOrThrow({ where: { id: video.id } }),
      prisma.clip.findUniqueOrThrow({ where: { id: clip.id } }),
    ]);
    expect(videoAfterSecond.status).toBe("FAILED");
    expect(clipAfterSecond.status).toBe("FAILED");
    expect(second).toBeDefined();
  });
});
