import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getClipAbsolutePath } from "@/lib/storage";
import { headers } from "next/headers";

export async function GET(
  request: Request,
  {
    params,
  }: RouteContext<"/api/projects/[id]/videos/[videoId]/clips/[clipId]/download">
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

  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    include: { video: { include: { project: true } } },
  });

  if (
    !clip ||
    clip.videoId !== videoId ||
    clip.video.projectId !== projectId ||
    clip.video.project.userId !== session.user.id
  ) {
    return Response.json(
      { error: "Clipe não encontrado" },
      { status: 404 }
    );
  }

  if (clip.status !== "COMPLETED" || !clip.outputPath) {
    return Response.json(
      { error: "Clipe ainda não está pronto" },
      { status: 409 }
    );
  }

  const absolutePath = getClipAbsolutePath(clip.outputPath);
  const { size } = await stat(absolutePath);
  const safeFilename = (clip.title || clip.id).replace(/[^a-zA-Z0-9.\-_ ]/g, "_");

  return new Response(Readable.toWeb(createReadStream(absolutePath)) as never, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": size.toString(),
      "Content-Disposition": `attachment; filename="${safeFilename}.mp4"`,
    },
  });
}
