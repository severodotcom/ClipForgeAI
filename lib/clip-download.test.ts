import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getClipAbsolutePath } from "@/lib/storage";
import { getOwnedClip } from "@/lib/ownership";

/**
 * Réplica de
 * app/api/projects/[id]/videos/[videoId]/clips/[clipId]/download/route.ts
 * (GET), cobrindo o tratamento de ENOENT do P2h.
 */
async function replicaDownloadFlow(
  userId: string,
  projectId: string,
  videoId: string,
  clipId: string
) {
  const clip = await getOwnedClip(projectId, videoId, clipId, userId);

  if (!clip) {
    return { status: 404 as const, error: "Clipe não encontrado" };
  }

  if (clip.status !== "COMPLETED" || !clip.outputPath) {
    return { status: 409 as const };
  }

  const absolutePath = getClipAbsolutePath(clip.outputPath);

  let size: number;
  try {
    ({ size } = await stat(absolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: 404 as const, code: "FILE_NOT_FOUND" as const };
    }

    return { status: 500 as const };
  }

  return { status: 200 as const, size };
}

describe("GET .../clips/[clipId]/download — tratamento de arquivo ausente (P2h)", () => {
  const runId = randomUUID();

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `clip-download-${label}-${runId}@clipforge.test`, name: label },
    });
    return user.id;
  }

  async function createVideo(projectId: string) {
    return prisma.video.create({
      data: { projectId, originalFilename: "v.mp4", status: "COMPLETED", duration: 60 },
    });
  }

  it("arquivo existe: comportamento atual permanece (200, size correto)", async () => {
    const userId = await createUser("ok");
    const project = await prisma.project.create({ data: { userId, name: "Projeto download ok" } });
    const video = await createVideo(project.id);
    const outputPath = path.join(project.id, video.id, "clip.mp4");

    const clip = await prisma.clip.create({
      data: { videoId: video.id, startTime: 0, endTime: 5, status: "COMPLETED", outputPath },
    });

    const absPath = getClipAbsolutePath(outputPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, "conteudo-fake-de-clip");

    const result = await replicaDownloadFlow(userId, project.id, video.id, clip.id);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.size).toBe(Buffer.byteLength("conteudo-fake-de-clip"));
    }

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
  });

  it("arquivo ausente (registro COMPLETED, arquivo desapareceu): 404 com code FILE_NOT_FOUND, não 500 genérico", async () => {
    const userId = await createUser("missing-file");
    const project = await prisma.project.create({ data: { userId, name: "Projeto arquivo ausente" } });
    const video = await createVideo(project.id);
    const outputPath = path.join(project.id, video.id, "fantasma.mp4");

    const clip = await prisma.clip.create({
      data: { videoId: video.id, startTime: 0, endTime: 5, status: "COMPLETED", outputPath },
    });

    const result = await replicaDownloadFlow(userId, project.id, video.id, clip.id);

    expect(result.status).toBe(404);
    if (result.status === 404 && "code" in result) {
      expect(result.code).toBe("FILE_NOT_FOUND");
    }

    await prisma.user.delete({ where: { id: userId } });
  });

  it("erro de filesystem diferente de ENOENT (ex: ENOTDIR): resposta de erro interno (500), distinta do caso de arquivo ausente", async () => {
    const userId = await createUser("enotdir");
    const project = await prisma.project.create({ data: { userId, name: "Projeto ENOTDIR" } });
    const video = await createVideo(project.id);
    const outputPath = path.join(project.id, video.id, "trap.mp4");

    const clip = await prisma.clip.create({
      data: { videoId: video.id, startTime: 0, endTime: 5, status: "COMPLETED", outputPath },
    });

    // Mesmo truque de lib/video-stream.test.ts: torna o diretório pai um
    // ARQUIVO, para que stat() do caminho completo falhe com ENOTDIR (não
    // ENOENT) — stat() não lança para um diretório existente, então um
    // truque de EISDIR não se aplicaria aqui.
    const absPath = getClipAbsolutePath(outputPath);
    await mkdir(path.dirname(path.dirname(absPath)), { recursive: true });
    await writeFile(path.dirname(absPath), "não é um diretório");

    const result = await replicaDownloadFlow(userId, project.id, video.id, clip.id);
    expect(result.status).toBe(500);

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.dirname(absPath), { force: true });
  });

  it("outro usuário não consegue descobrir a existência do clipe (404 antes de qualquer acesso a arquivo)", async () => {
    const ownerId = await createUser("owner");
    const attackerId = await createUser("attacker");

    const project = await prisma.project.create({ data: { userId: ownerId, name: "Projeto do dono" } });
    const video = await createVideo(project.id);
    const outputPath = path.join(project.id, video.id, "clip.mp4");

    const clip = await prisma.clip.create({
      data: { videoId: video.id, startTime: 0, endTime: 5, status: "COMPLETED", outputPath },
    });

    const absPath = getClipAbsolutePath(outputPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, "conteudo-fake");

    const result = await replicaDownloadFlow(attackerId, project.id, video.id, clip.id);

    expect(result.status).toBe(404);
    expect("code" in result ? result.code : undefined).not.toBe("FILE_NOT_FOUND");

    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.user.delete({ where: { id: attackerId } });
    await rm(path.join(process.cwd(), "storage", "clips", project.id), { recursive: true, force: true });
  });
});
