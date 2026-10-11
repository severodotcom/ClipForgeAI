import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getVideoAbsolutePath } from "@/lib/storage";
import { getOwnedVideo } from "@/lib/ownership";

/**
 * Réplica de app/api/projects/[id]/videos/[videoId]/stream/route.ts (GET),
 * cobrindo o tratamento de ENOENT do P2h — mesmo motivo de
 * lib/rate-limit-routes.test.ts para não importar a rota diretamente
 * (depende de `headers()` de next/headers).
 */
async function replicaStreamFlow(userId: string, projectId: string, videoId: string) {
  const video = await getOwnedVideo(projectId, videoId, userId);

  if (!video || !video.storagePath) {
    return { status: 404 as const, error: "Vídeo não encontrado" };
  }

  const absolutePath = getVideoAbsolutePath(video.storagePath);

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

describe("GET .../videos/[videoId]/stream — tratamento de arquivo ausente (P2h)", () => {
  const runId = randomUUID();

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `video-stream-${label}-${runId}@clipforge.test`, name: label },
    });
    return user.id;
  }

  it("arquivo existe: comportamento atual permanece (200, size correto)", async () => {
    const userId = await createUser("ok");
    const project = await prisma.project.create({ data: { userId, name: "Projeto stream ok" } });
    const storagePath = path.join(project.id, "video.mp4");

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "video.mp4",
        status: "COMPLETED",
        duration: 10,
        storagePath,
      },
    });

    const absPath = getVideoAbsolutePath(storagePath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, "conteudo-fake-de-video");

    const result = await replicaStreamFlow(userId, project.id, video.id);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.size).toBe(Buffer.byteLength("conteudo-fake-de-video"));
    }

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
  });

  it("arquivo ausente (registro existe, arquivo desapareceu): 404 com code FILE_NOT_FOUND, não 500 genérico", async () => {
    const userId = await createUser("missing-file");
    const project = await prisma.project.create({ data: { userId, name: "Projeto arquivo ausente" } });
    const storagePath = path.join(project.id, "fantasma.mp4");

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "fantasma.mp4",
        status: "COMPLETED",
        duration: 10,
        storagePath,
      },
    });

    // Nunca cria o arquivo em disco — simula "apagado manualmente".
    const result = await replicaStreamFlow(userId, project.id, video.id);

    expect(result.status).toBe(404);
    if (result.status === 404 && "code" in result) {
      expect(result.code).toBe("FILE_NOT_FOUND");
    }

    await prisma.user.delete({ where: { id: userId } });
  });

  it("erro de filesystem diferente de ENOENT (ex: ENOTDIR): resposta de erro interno (500), distinta do caso de arquivo ausente", async () => {
    const userId = await createUser("enotdir");
    const project = await prisma.project.create({ data: { userId, name: "Projeto ENOTDIR" } });
    const storagePath = path.join(project.id, "trap.mp4");

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "trap.mp4",
        status: "COMPLETED",
        duration: 10,
        storagePath,
      },
    });

    // Torna o diretório do projeto um ARQUIVO (não um diretório) — stat()
    // do caminho completo então falha com ENOTDIR, não ENOENT (stat() não
    // lança para um diretório existente, então um truque de EISDIR não
    // funcionaria aqui — ENOTDIR é o jeito determinístico de produzir um
    // erro de stat() que não seja "arquivo ausente").
    const absPath = getVideoAbsolutePath(storagePath);
    await mkdir(path.dirname(path.dirname(absPath)), { recursive: true });
    await writeFile(path.dirname(absPath), "não é um diretório");

    const result = await replicaStreamFlow(userId, project.id, video.id);
    expect(result.status).toBe(500);

    await prisma.user.delete({ where: { id: userId } });
    await rm(path.dirname(absPath), { force: true });
  });

  it("outro usuário não consegue descobrir a existência do vídeo (404 antes de qualquer acesso a arquivo)", async () => {
    const ownerId = await createUser("owner");
    const attackerId = await createUser("attacker");

    const project = await prisma.project.create({ data: { userId: ownerId, name: "Projeto do dono" } });
    const storagePath = path.join(project.id, "video.mp4");

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "video.mp4",
        status: "COMPLETED",
        duration: 10,
        storagePath,
      },
    });

    const absPath = getVideoAbsolutePath(storagePath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, "conteudo-fake");

    const result = await replicaStreamFlow(attackerId, project.id, video.id);

    // Mesmo 404 "Vídeo não encontrado" que um ID inexistente produziria —
    // não um código diferente que confirmaria "o recurso existe, mas não é
    // seu" nem um 500/403 que revelaria algo sobre o arquivo.
    expect(result.status).toBe(404);
    expect("code" in result ? result.code : undefined).not.toBe("FILE_NOT_FOUND");

    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.user.delete({ where: { id: attackerId } });
    await rm(path.join(process.cwd(), "storage", "videos", project.id), { recursive: true, force: true });
  });
});
