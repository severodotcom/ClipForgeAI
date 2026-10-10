import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { deleteClipFile, getClipAbsolutePath } from "@/lib/storage";
import { getOwnedClip } from "@/lib/ownership";
import { checkRateLimit, rateLimitKey, RATE_LIMIT_RULES } from "@/lib/rate-limit";

/**
 * Réplica do DELETE endurecido em
 * app/api/projects/[id]/videos/[videoId]/clips/[clipId]/route.ts (P2g) —
 * mesmo motivo de lib/rate-limit-routes.test.ts para não importar a rota
 * diretamente (depende de `headers()` de next/headers).
 */
async function replicaClipDeleteFlow(
  userId: string,
  projectId: string,
  videoId: string,
  clipId: string
) {
  const rateDecision = checkRateLimit(
    rateLimitKey("clip-delete", userId),
    RATE_LIMIT_RULES.CLIP_DELETE
  );

  if (!rateDecision.allowed) {
    return { status: 429 as const, rateDecision };
  }

  const clip = await getOwnedClip(projectId, videoId, clipId, userId);

  if (!clip) {
    return { status: 404 as const };
  }

  if (clip.status === "GENERATING") {
    return { status: 409 as const };
  }

  try {
    if (clip.outputPath) {
      await deleteClipFile(clip.outputPath);
    }
  } catch {
    return { status: 500 as const };
  }

  const result = await prisma.clip.deleteMany({
    where: { id: clipId, videoId, status: { not: "GENERATING" } },
  });

  if (result.count === 0) {
    const stillExists = await prisma.clip.findUnique({ where: { id: clipId } });
    return { status: (stillExists ? 409 : 404) as 404 | 409 };
  }

  return { status: 204 as const };
}

describe("DELETE .../clips/[clipId] endurecido (P2g)", () => {
  const runId = randomUUID();

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `clip-delete-${label}-${runId}@clipforge.test`, name: label },
    });
    return user.id;
  }

  async function createVideo(projectId: string) {
    return prisma.video.create({
      data: { projectId, originalFilename: "v.mp4", status: "COMPLETED", duration: 60 },
    });
  }

  it("sucesso: remove o arquivo físico e responde 204; chamada repetida responde 404", async () => {
    const userId = await createUser("ok");
    const project = await prisma.project.create({ data: { userId, name: "Projeto clip ok" } });
    const video = await createVideo(project.id);

    const clip = await prisma.clip.create({
      data: {
        videoId: video.id,
        startTime: 0,
        endTime: 5,
        status: "COMPLETED",
        outputPath: path.join(project.id, video.id, "clip.mp4"),
      },
    });

    const clipAbsPath = getClipAbsolutePath(clip.outputPath!);
    await mkdir(path.dirname(clipAbsPath), { recursive: true });
    await writeFile(clipAbsPath, "clip-fake-bytes");

    const result = await replicaClipDeleteFlow(userId, project.id, video.id, clip.id);
    expect(result.status).toBe(204);

    await expect(stat(clipAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).toBeNull();

    const repeated = await replicaClipDeleteFlow(userId, project.id, video.id, clip.id);
    expect(repeated.status).toBe(404);

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
  });

  it("clipe inexistente responde 404", async () => {
    const userId = await createUser("missing");
    const project = await prisma.project.create({ data: { userId, name: "Projeto vazio" } });
    const video = await createVideo(project.id);

    const result = await replicaClipDeleteFlow(userId, project.id, video.id, randomUUID());
    expect(result.status).toBe(404);

    await prisma.user.delete({ where: { id: userId } });
  });

  it("clipe de outro usuário responde 404 (não revela existência)", async () => {
    const ownerId = await createUser("owner");
    const attackerId = await createUser("attacker");

    const project = await prisma.project.create({ data: { userId: ownerId, name: "Projeto do dono" } });
    const video = await createVideo(project.id);
    const clip = await prisma.clip.create({
      data: { videoId: video.id, startTime: 0, endTime: 5, status: "COMPLETED" },
    });

    const result = await replicaClipDeleteFlow(attackerId, project.id, video.id, clip.id);
    expect(result.status).toBe(404);
    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).not.toBeNull();

    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.user.delete({ where: { id: attackerId } });
  });

  it("clipe em GENERATING responde 409 e não remove nada", async () => {
    const userId = await createUser("generating");
    const project = await prisma.project.create({ data: { userId, name: "Projeto generating" } });
    const video = await createVideo(project.id);

    const clip = await prisma.clip.create({
      data: {
        videoId: video.id,
        startTime: 0,
        endTime: 5,
        status: "GENERATING",
        outputPath: path.join(project.id, video.id, "clip.mp4"),
      },
    });

    const clipAbsPath = getClipAbsolutePath(clip.outputPath!);
    await mkdir(path.dirname(clipAbsPath), { recursive: true });
    await writeFile(clipAbsPath, "sendo-gerado-agora");

    const result = await replicaClipDeleteFlow(userId, project.id, video.id, clip.id);
    expect(result.status).toBe(409);

    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).not.toBeNull();
    expect(await stat(clipAbsPath)).toBeTruthy();

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
  });

  it("outputPath já inexistente (ENOENT) ainda resulta em sucesso", async () => {
    const userId = await createUser("enoent");
    const project = await prisma.project.create({ data: { userId, name: "Projeto ENOENT" } });
    const video = await createVideo(project.id);

    const clip = await prisma.clip.create({
      data: {
        videoId: video.id,
        startTime: 0,
        endTime: 5,
        status: "COMPLETED",
        outputPath: path.join(project.id, video.id, "fantasma.mp4"),
      },
    });

    const result = await replicaClipDeleteFlow(userId, project.id, video.id, clip.id);
    expect(result.status).toBe(204);

    await prisma.user.delete({ where: { id: userId } });
  });

  it("erro real de storage (EISDIR) aborta e não apaga o banco", async () => {
    const userId = await createUser("eisdir");
    const project = await prisma.project.create({ data: { userId, name: "Projeto EISDIR" } });
    const video = await createVideo(project.id);

    const trapRelativePath = path.join(project.id, video.id, "trap.mp4");
    const trapAbsPath = getClipAbsolutePath(trapRelativePath);
    await mkdir(trapAbsPath, { recursive: true });

    const clip = await prisma.clip.create({
      data: {
        videoId: video.id,
        startTime: 0,
        endTime: 5,
        status: "COMPLETED",
        outputPath: trapRelativePath,
      },
    });

    const result = await replicaClipDeleteFlow(userId, project.id, video.id, clip.id);
    expect(result.status).toBe(500);
    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).not.toBeNull();

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
  });

  it("a 21ª chamada em 10 minutos é bloqueada pelo rate limit antes de consultar ownership", async () => {
    const userId = await createUser("rate-limit");
    let ownershipLookups = 0;

    async function replicaWithCounter() {
      const rateDecision = checkRateLimit(
        rateLimitKey("clip-delete", userId),
        RATE_LIMIT_RULES.CLIP_DELETE
      );

      if (!rateDecision.allowed) {
        return { status: 429 as const, rateDecision };
      }

      ownershipLookups += 1;
      const clip = await getOwnedClip(randomUUID(), randomUUID(), randomUUID(), userId);
      return { status: (clip ? 200 : 404) as 200 | 404 };
    }

    const results = [];
    for (let i = 0; i < 21; i++) {
      results.push(await replicaWithCounter());
    }

    expect(ownershipLookups).toBe(RATE_LIMIT_RULES.CLIP_DELETE.max);
    expect(results.slice(0, 20).every((r) => r.status === 404)).toBe(true);

    const twentyFirst = results[20];
    expect(twentyFirst.status).toBe(429);
    if (twentyFirst.status === 429) {
      expect(twentyFirst.rateDecision.limit).toBe(RATE_LIMIT_RULES.CLIP_DELETE.max);
      expect(twentyFirst.rateDecision.remaining).toBe(0);
    }

    await prisma.user.delete({ where: { id: userId } });
  });
});
