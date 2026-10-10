import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteProjectFiles, getClipAbsolutePath, getVideoAbsolutePath } from "@/lib/storage";
import { checkRateLimit, rateLimitKey, RATE_LIMIT_RULES } from "@/lib/rate-limit";

const BLOCKED_VIDEO_STATUSES: VideoStatus[] = ["TRANSCRIBING", "ANALYZING", "GENERATING"];

/**
 * Testes de integração para DELETE /api/projects/[id] (P2g), contra um
 * Postgres real e o filesystem real de storage/ — mesmo motivo já
 * documentado em lib/rate-limit-routes.test.ts para não importar o módulo
 * da rota diretamente (usa `headers()` de `next/headers`, só funciona
 * dentro do runtime real de uma request do Next.js): esta réplica
 * reproduz app/api/projects/[id]/route.ts (DELETE) campo a campo.
 */
async function replicaProjectDeleteFlow(userId: string, projectId: string) {
  const rateDecision = checkRateLimit(
    rateLimitKey("project-delete", userId),
    RATE_LIMIT_RULES.PROJECT_DELETE
  );

  if (!rateDecision.allowed) {
    return { status: 429 as const, rateDecision };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project || project.userId !== userId) {
    return { status: 404 as const };
  }

  const processingVideo = await prisma.video.findFirst({
    where: { projectId, status: { in: BLOCKED_VIDEO_STATUSES } },
    select: { id: true },
  });

  if (processingVideo) {
    return { status: 409 as const };
  }

  const videos = await prisma.video.findMany({
    where: { projectId },
    select: {
      storagePath: true,
      clips: { select: { outputPath: true } },
    },
  });

  const videoPaths = videos
    .map((video) => video.storagePath)
    .filter((p): p is string => p != null);

  const clipPaths = videos
    .flatMap((video) => video.clips.map((clip) => clip.outputPath))
    .filter((p): p is string => p != null);

  try {
    await deleteProjectFiles({ videoPaths, clipPaths });
  } catch {
    return { status: 500 as const };
  }

  const result = await prisma.project.deleteMany({
    where: { id: projectId, userId },
  });

  if (result.count === 0) {
    return { status: 404 as const };
  }

  return { status: 204 as const };
}

describe("DELETE /api/projects/[id] (P2g)", () => {
  const runId = randomUUID();

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `project-delete-${label}-${runId}@clipforge.test`, name: label },
    });
    return user.id;
  }

  describe("sucesso e efeitos colaterais", () => {
    let userId: string;
    let projectId: string;
    let videoAbsPath: string;
    let clipAbsPath: string;

    it("remove arquivos físicos, cascateia Video/Transcription/Clip/AnalysisCache, e responde como sucesso", async () => {
      userId = await createUser("ok");

      const project = await prisma.project.create({
        data: { userId, name: "Projeto a excluir" },
      });
      projectId = project.id;

      const video = await prisma.video.create({
        data: {
          projectId,
          originalFilename: "video.mp4",
          status: "COMPLETED",
          duration: 60,
          storagePath: path.join(projectId, "video.mp4"),
        },
      });

      await prisma.transcription.create({
        data: { videoId: video.id, text: "texto", segments: [] },
      });

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
          endTime: 10,
          status: "COMPLETED",
          outputPath: path.join(projectId, video.id, "clip.mp4"),
        },
      });

      videoAbsPath = getVideoAbsolutePath(video.storagePath!);
      clipAbsPath = getClipAbsolutePath(clip.outputPath!);

      await mkdir(path.dirname(videoAbsPath), { recursive: true });
      await writeFile(videoAbsPath, "video-fake-bytes");
      await mkdir(path.dirname(clipAbsPath), { recursive: true });
      await writeFile(clipAbsPath, "clip-fake-bytes");

      const result = await replicaProjectDeleteFlow(userId, projectId);
      expect(result.status).toBe(204);

      await expect(stat(videoAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(clipAbsPath)).rejects.toMatchObject({ code: "ENOENT" });

      expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull();
      expect(await prisma.video.findUnique({ where: { id: video.id } })).toBeNull();
      expect(await prisma.transcription.findUnique({ where: { videoId: video.id } })).toBeNull();
      expect(await prisma.clip.findUnique({ where: { id: clip.id } })).toBeNull();
      expect(await prisma.analysisCache.findMany({ where: { videoId: video.id } })).toHaveLength(0);
    });

    it("uma segunda chamada (delete repetido) responde 404", async () => {
      const result = await replicaProjectDeleteFlow(userId, projectId);
      expect(result.status).toBe(404);
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: userId } });
      await rm(path.join(process.cwd(), "storage", "videos", projectId), { recursive: true, force: true });
      await rm(path.join(process.cwd(), "storage", "clips", projectId), { recursive: true, force: true });
    });
  });

  describe("exclusão bloqueada por vídeo em processamento", () => {
    it.each(["TRANSCRIBING", "ANALYZING", "GENERATING"] as const)(
      "projeto com um vídeo em %s responde 409, sem remover arquivos, excluir registros ou tocar quota",
      async (status) => {
        const userId = await createUser(`blocked-${status.toLowerCase()}`);
        const project = await prisma.project.create({
          data: { userId, name: `Projeto bloqueado ${status}` },
        });

        const video = await prisma.video.create({
          data: {
            projectId: project.id,
            originalFilename: "em-processamento.mp4",
            status,
            duration: 60,
            storagePath: path.join(project.id, "em-processamento.mp4"),
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
        await writeFile(videoAbsPath, "video-sendo-processado");
        await mkdir(path.dirname(clipAbsPath), { recursive: true });
        await writeFile(clipAbsPath, "clip-ja-pronto");

        const usageCountBefore = await prisma.usageRecord.count({ where: { userId } });

        const result = await replicaProjectDeleteFlow(userId, project.id);
        expect(result.status).toBe(409);

        // Nada foi tocado: nem o banco (Project/Video/Clip), nem os
        // arquivos físicos, nem UsageRecord/quota.
        expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();
        const videoAfter = await prisma.video.findUnique({ where: { id: video.id } });
        expect(videoAfter?.status).toBe(status);
        expect(await prisma.clip.findUnique({ where: { id: clip.id } })).not.toBeNull();
        expect(await stat(videoAbsPath)).toBeTruthy();
        expect(await stat(clipAbsPath)).toBeTruthy();
        expect(await prisma.usageRecord.count({ where: { userId } })).toBe(usageCountBefore);

        await prisma.user.delete({ where: { id: userId } });
        await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
        await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
      }
    );

    it("projeto sem nenhum vídeo em processamento continua respondendo 204", async () => {
      const userId = await createUser("not-blocked");
      const project = await prisma.project.create({
        data: { userId, name: "Projeto sem processamento" },
      });

      await prisma.video.create({
        data: {
          projectId: project.id,
          originalFilename: "pronto.mp4",
          status: "COMPLETED",
          duration: 30,
        },
      });

      const result = await replicaProjectDeleteFlow(userId, project.id);
      expect(result.status).toBe(204);
      expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();

      await prisma.user.deleteMany({ where: { id: userId } });
    });
  });

  describe("projeto inexistente / de outro usuário", () => {
    it("ID que nunca existiu responde 404", async () => {
      const ownerId = await createUser("owner-missing");
      const result = await replicaProjectDeleteFlow(ownerId, randomUUID());
      expect(result.status).toBe(404);
      await prisma.user.delete({ where: { id: ownerId } });
    });

    it("projeto de outro usuário responde 404 (não revela existência)", async () => {
      const ownerId = await createUser("owner-other");
      const otherUserId = await createUser("attacker");

      const project = await prisma.project.create({
        data: { userId: ownerId, name: "Projeto do dono" },
      });

      const result = await replicaProjectDeleteFlow(otherUserId, project.id);
      expect(result.status).toBe(404);

      // o projeto do dono real não foi afetado pela tentativa do atacante.
      expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();

      await prisma.user.delete({ where: { id: ownerId } });
      await prisma.user.delete({ where: { id: otherUserId } });
    });
  });

  describe("arquivo já inexistente (ENOENT tolerado)", () => {
    it("storagePath apontando para um arquivo que não existe mais ainda resulta em sucesso", async () => {
      const userId = await createUser("enoent");
      const project = await prisma.project.create({ data: { userId, name: "Projeto ENOENT" } });

      await prisma.video.create({
        data: {
          projectId: project.id,
          originalFilename: "fantasma.mp4",
          status: "COMPLETED",
          duration: 10,
          storagePath: path.join(project.id, "fantasma-que-nao-existe.mp4"),
        },
      });

      const result = await replicaProjectDeleteFlow(userId, project.id);
      expect(result.status).toBe(204);
      expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();

      await prisma.user.delete({ where: { id: userId } });
    });
  });

  describe("erro real de storage (não ENOENT) aborta antes do banco", () => {
    it("um storagePath que resolve para um diretório (EISDIR) impede a exclusão do projeto", async () => {
      const userId = await createUser("eisdir");
      const project = await prisma.project.create({ data: { userId, name: "Projeto EISDIR" } });

      const trapRelativePath = path.join(project.id, "trap.mp4");
      const trapAbsPath = getVideoAbsolutePath(trapRelativePath);
      await mkdir(trapAbsPath, { recursive: true }); // vira um diretório, não um arquivo

      await prisma.video.create({
        data: {
          projectId: project.id,
          originalFilename: "trap.mp4",
          status: "COMPLETED",
          duration: 10,
          storagePath: trapRelativePath,
        },
      });

      const result = await replicaProjectDeleteFlow(userId, project.id);
      expect(result.status).toBe(500);

      // o banco NÃO foi tocado: o projeto e o vídeo continuam existindo.
      expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();
      expect(await stat(trapAbsPath)).toBeTruthy();

      await prisma.user.delete({ where: { id: userId } });
      await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
    });
  });

  describe("rate limit (P2g)", () => {
    it("a 6ª chamada em 10 minutos é bloqueada pelo rate limit antes de consultar o banco", async () => {
      const userId = await createUser("rate-limit");
      let dbLookups = 0;

      async function replicaWithCounter() {
        const rateDecision = checkRateLimit(
          rateLimitKey("project-delete", userId),
          RATE_LIMIT_RULES.PROJECT_DELETE
        );

        if (!rateDecision.allowed) {
          return { status: 429 as const, rateDecision };
        }

        dbLookups += 1;
        const project = await prisma.project.findUnique({ where: { id: randomUUID() } });
        return { status: project ? (200 as const) : (404 as const) };
      }

      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(await replicaWithCounter());
      }

      expect(dbLookups).toBe(RATE_LIMIT_RULES.PROJECT_DELETE.max);
      expect(results.slice(0, 5).every((r) => r.status === 404)).toBe(true);

      const sixth = results[5];
      expect(sixth.status).toBe(429);
      if (sixth.status === 429) {
        expect(sixth.rateDecision.limit).toBe(RATE_LIMIT_RULES.PROJECT_DELETE.max);
        expect(sixth.rateDecision.remaining).toBe(0);
      }

      await prisma.user.delete({ where: { id: userId } });
    });
  });
});
