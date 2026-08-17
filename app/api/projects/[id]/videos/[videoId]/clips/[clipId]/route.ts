import { rm } from "node:fs/promises";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateClip } from "@/lib/clips";
import { getClipAbsolutePath } from "@/lib/storage";
import { getOwnedClip } from "@/lib/ownership";
import { headers } from "next/headers";

export async function PATCH(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/clips/[clipId]">
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json(
      { error: "Não autenticado" },
      { status: 401 }
    );
  }

  const { id: projectId, videoId, clipId } = await params;

  const clip = await getOwnedClip(projectId, videoId, clipId, session.user.id);

  if (!clip) {
    return Response.json(
      { error: "Clipe não encontrado" },
      { status: 404 }
    );
  }

  const body = await request.json();
  const data: {
    title?: string | null;
    startTime?: number;
    endTime?: number;
    status?: "PENDING";
    outputPath?: null;
  } = {};

  if (typeof body.title === "string") {
    data.title = body.title.trim() || null;
  }

  const wantsNewRange =
    body.startTime !== undefined || body.endTime !== undefined;

  if (wantsNewRange) {
    const startTime = Number(body.startTime ?? clip.startTime);
    const endTime = Number(body.endTime ?? clip.endTime);

    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      startTime < 0 ||
      endTime <= startTime
    ) {
      return Response.json(
        { error: "Intervalo de tempo inválido" },
        { status: 400 }
      );
    }

    if (clip.video.duration != null && endTime > clip.video.duration) {
      return Response.json(
        { error: "O fim do clipe não pode ultrapassar a duração do vídeo" },
        { status: 400 }
      );
    }

    data.startTime = startTime;
    data.endTime = endTime;
    data.status = "PENDING";
    data.outputPath = null;
  }

  const updated = await prisma.clip.update({
    where: { id: clipId },
    data,
  });

  if (wantsNewRange) {
    if (clip.outputPath) {
      await rm(getClipAbsolutePath(clip.outputPath), { force: true }).catch(
        () => {}
      );
    }

    generateClip(clipId).catch((error) => {
      console.error(`Falha ao regenerar o clipe ${clipId}:`, error);
    });
  }

  return Response.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/clips/[clipId]">
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json(
      { error: "Não autenticado" },
      { status: 401 }
    );
  }

  const { id: projectId, videoId, clipId } = await params;

  const clip = await getOwnedClip(projectId, videoId, clipId, session.user.id);

  if (!clip) {
    return Response.json(
      { error: "Clipe não encontrado" },
      { status: 404 }
    );
  }

  if (clip.outputPath) {
    await rm(getClipAbsolutePath(clip.outputPath), { force: true }).catch(
      () => {}
    );
  }

  await prisma.clip.delete({ where: { id: clipId } });

  return new Response(null, { status: 204 });
}
