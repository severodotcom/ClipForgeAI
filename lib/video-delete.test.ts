import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteClipFile, deleteVideoFile, getClipAbsolutePath, getVideoAbsolutePath } from "@/lib/storage";
import { getOwnedVideo } from "@/lib/ownership";
import { checkRateLimit, rateLimitKey, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { getPeriodStart, getUsageThisPeriod, recordUsage } from "@/lib/usage";
import { UsageType } from "@prisma/client";

const BLOCKED_VIDEO_STATUSES: VideoStatus[] = ["TRANSCRIBING", "ANALYZING", "GENERATING"];

/**
 * Réplica de app/api/projects/[id]/videos/[videoId]/route.ts (DELETE) —
 * mesmo motivo de lib/rate-limit-routes.test.ts para não importar a rota
 * diretamente (depende de `headers()` de next/headers).
 */
async function replicaVideoDeleteFlow(userId: string, projectId: string, videoId: string) {
  const rateDecision = checkRateLimit(
    rateLimitKey("video-delete", userId),
    RATE_LIMIT_RULES.VIDEO_DELETE
  );

  if (!rateDecision.allowed) {
    return { status: 429 as const, rateDecision };
  }

  const video = await getOwnedVideo(projectId, videoId, userId);

  if (!video) {
    return { status: 404 as const };
  }

  if (BLOCKED_VIDEO_STATUSES.includes(video.status)) {
    return { status: 409 as const };
  }

  const clips = await prisma.clip.findMany({
    where: { videoId },
    select: { outputPath: true },
  });

  const clipPaths = clips
    .map((clip) => clip.outputPath)
    .filter((p): p is string => p != null);

  try {
    if (video.storagePath) {
      await deleteVideoFile(video.storagePath);
    }

    for (const clipPath of clipPaths) {
      await deleteClipFile(clipPath);
    }
  } catch {
    return { status: 500 as const };
  }

  const result = await prisma.video.deleteMany({
    where: { id: videoId, projectId, status: { notIn: BLOCKED_VIDEO_STATUSES } },
  });

  if (result.count === 0) {
    const stillExists = await prisma.video.findUnique({ where: { id: videoId } });
    return { status: (stillExists ? 409 : 404) as 404 | 409 };
  }

  return { status: 204 as const };
}

describe("DELETE /api/projects/[id]/videos/[videoId] (P2g)", () => {
  const runId = randomUUID();

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `video-delete-${label}-${runId}@clipforge.test`, name: label },
    });
    return user.id;
  }

  it("sucesso: remove arquivos físicos, cascateia Transcription/Clip/AnalysisCache e responde 204", async () => {
    const userId = await createUser("ok");
    const project = await prisma.project.create({ data: { userId, name: "Projeto vídeo ok" } });

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "video.mp4",
        status: "COMPLETED",
        duration: 60,
        storagePath: path.join(project.id, "video.mp4"),
      },
    });

    await prisma.transcription.create({ data: { videoId: video.id, text: "texto", segments: [] } });
    await prisma.analysisCache.create({
      data: {
        videoId: video.id,
        transcriptHash: "hash",
        model: "gpt-4o-mini",
        analyzerVersion: "v1",
        suggestions: [],
      },
    });

    const clip = await prisma.clip.create({
      data: {
        videoId: video.id,
        startTime: 0,
        endTime: 5,
        status: "COMPLETED",
        outputPath: path.join(project.id, video.id, "clip.mp4"),
      },
    });

    const videoAbsPath = getVideoAbsolutePath(video.storagePath!);
    const clipAbsPath = getClipAbsolutePath(clip.outputPath!);
    await mkdir(path.dirname(videoAbsPath), { recursive: true });
    await writeFile(videoAbsPath, "video-fake-bytes");
    await mkdir(path.dirname(clipAbsPath), { recursive: true });
    await writeFile(clipAbsPath, "clip-fake-bytes");

    const result = await replicaVideoDeleteFlow(userId, project.id, video.id);
    expect(result.status).toBe(204);

    await expect(stat(videoAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(clipAbsPath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await prisma.video.findUnique({ where: { id: video.id } })).toBeNull();
    expect(await prisma.transcription.findUnique({ where: { videoId: video.id } })).toBeNull();
    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).toBeNull();
    expect(await prisma.analysisCache.findMany({ where: { videoId: video.id } })).toHaveLength(0);

    // o Project em si não foi tocado — só o Video e o que cascateia dele.
    expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();

    // segunda chamada (delete repetido) responde 404.
    const repeated = await replicaVideoDeleteFlow(userId, project.id, video.id);
    expect(repeated.status).toBe(404);

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
    await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
  });

  it("vídeo inexistente responde 404", async () => {
    const userId = await createUser("missing");
    const project = await prisma.project.create({ data: { userId, name: "Projeto vazio" } });

    const result = await replicaVideoDeleteFlow(userId, project.id, randomUUID());
    expect(result.status).toBe(404);

    await prisma.user.delete({ where: { id: userId } });
  });

  it("vídeo de outro usuário responde 404 (não revela existência)", async () => {
    const ownerId = await createUser("owner");
    const attackerId = await createUser("attacker");

    const project = await prisma.project.create({ data: { userId: ownerId, name: "Projeto do dono" } });
    const video = await prisma.video.create({
      data: { projectId: project.id, originalFilename: "v.mp4", status: "UPLOADED", duration: 10 },
    });

    const result = await replicaVideoDeleteFlow(attackerId, project.id, video.id);
    expect(result.status).toBe(404);
    expect(await prisma.video.findUnique({ where: { id: video.id } })).not.toBeNull();

    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.user.delete({ where: { id: attackerId } });
  });

  describe("recurso em processamento", () => {
    it.each(["TRANSCRIBING", "ANALYZING", "GENERATING"] as const)(
      "vídeo em %s responde 409 e não remove nada",
      async (status) => {
        const userId = await createUser(`processing-${status.toLowerCase()}`);
        const project = await prisma.project.create({ data: { userId, name: `Projeto ${status}` } });

        const video = await prisma.video.create({
          data: {
            projectId: project.id,
            originalFilename: "v.mp4",
            status,
            duration: 30,
            storagePath: path.join(project.id, "v.mp4"),
          },
        });

        const videoAbsPath = getVideoAbsolutePath(video.storagePath!);
        await mkdir(path.dirname(videoAbsPath), { recursive: true });
        await writeFile(videoAbsPath, "ainda-sendo-processado");

        const result = await replicaVideoDeleteFlow(userId, project.id, video.id);
        expect(result.status).toBe(409);

        expect(await prisma.video.findUnique({ where: { id: video.id } })).not.toBeNull();
        expect(await stat(videoAbsPath)).toBeTruthy();

        await prisma.user.delete({ where: { id: userId } });
        await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
      }
    );
  });

  it("arquivo já inexistente (ENOENT) ainda resulta em sucesso", async () => {
    const userId = await createUser("enoent");
    const project = await prisma.project.create({ data: { userId, name: "Projeto ENOENT" } });

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "fantasma.mp4",
        status: "COMPLETED",
        duration: 10,
        storagePath: path.join(project.id, "fantasma.mp4"),
      },
    });

    const result = await replicaVideoDeleteFlow(userId, project.id, video.id);
    expect(result.status).toBe(204);

    await prisma.user.delete({ where: { id: userId } });
  });

  it("erro real de storage (EISDIR) aborta e não apaga o banco", async () => {
    const userId = await createUser("eisdir");
    const project = await prisma.project.create({ data: { userId, name: "Projeto EISDIR" } });

    const trapRelativePath = path.join(project.id, "trap.mp4");
    const trapAbsPath = getVideoAbsolutePath(trapRelativePath);
    await mkdir(trapAbsPath, { recursive: true });

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "trap.mp4",
        status: "COMPLETED",
        duration: 10,
        storagePath: trapRelativePath,
      },
    });

    const result = await replicaVideoDeleteFlow(userId, project.id, video.id);
    expect(result.status).toBe(500);
    expect(await prisma.video.findUnique({ where: { id: video.id } })).not.toBeNull();

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
  });

  it("quota de uso (UsageRecord) permanece inalterada após a exclusão", async () => {
    const userId = await createUser("quota");
    const project = await prisma.project.create({ data: { userId, name: "Projeto quota" } });

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "v.mp4",
        status: "COMPLETED",
        duration: 120,
      },
    });

    await recordUsage({
      userId,
      type: UsageType.VIDEO_UPLOAD,
      amount: 1,
      periodStart: getPeriodStart(),
      idempotencyKey: `VIDEO_UPLOAD:${video.id}`,
      videoId: video.id,
    });

    await recordUsage({
      userId,
      type: UsageType.TRANSCRIPTION_MINUTES,
      amount: 2,
      periodStart: getPeriodStart(),
      idempotencyKey: `TRANSCRIPTION_MINUTES:${video.id}`,
      videoId: video.id,
    });

    const usageBefore = await getUsageThisPeriod(userId);

    const result = await replicaVideoDeleteFlow(userId, project.id, video.id);
    expect(result.status).toBe(204);

    const usageAfter = await getUsageThisPeriod(userId);
    expect(usageAfter).toEqual(usageBefore);
    expect(usageAfter.videos).toBe(1);
    expect(usageAfter.minutes).toBe(2);

    await prisma.user.delete({ where: { id: userId } });
  });

  it("a 11ª chamada em 10 minutos é bloqueada pelo rate limit antes de consultar ownership", async () => {
    const userId = await createUser("rate-limit");
    let ownershipLookups = 0;

    async function replicaWithCounter() {
      const rateDecision = checkRateLimit(
        rateLimitKey("video-delete", userId),
        RATE_LIMIT_RULES.VIDEO_DELETE
      );

      if (!rateDecision.allowed) {
        return { status: 429 as const, rateDecision };
      }

      ownershipLookups += 1;
      const video = await getOwnedVideo(randomUUID(), randomUUID(), userId);
      return { status: (video ? 200 : 404) as 200 | 404 };
    }

    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push(await replicaWithCounter());
    }

    expect(ownershipLookups).toBe(RATE_LIMIT_RULES.VIDEO_DELETE.max);
    expect(results.slice(0, 10).every((r) => r.status === 404)).toBe(true);

    const eleventh = results[10];
    expect(eleventh.status).toBe(429);
    if (eleventh.status === 429) {
      expect(eleventh.rateDecision.limit).toBe(RATE_LIMIT_RULES.VIDEO_DELETE.max);
      expect(eleventh.rateDecision.remaining).toBe(0);
    }

    await prisma.user.delete({ where: { id: userId } });
  });
});
