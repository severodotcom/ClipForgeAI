import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveVideoFile } from "@/lib/storage";
import { headers } from "next/headers";

const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

async function getOwnedProject(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project || project.userId !== userId) {
    return null;
  }

  return project;
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos">
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

  const { id: projectId } = await params;

  const project = await getOwnedProject(projectId, session.user.id);

  if (!project) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return Response.json(
      { error: "Nenhum arquivo de vídeo enviado" },
      { status: 400 }
    );
  }

  if (!file.type.startsWith("video/")) {
    return Response.json(
      { error: "O arquivo enviado precisa ser um vídeo" },
      { status: 400 }
    );
  }

  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    return Response.json(
      { error: "O arquivo excede o tamanho máximo permitido (2GB)" },
      { status: 400 }
    );
  }

  const video = await prisma.video.create({
    data: {
      projectId,
      originalFilename: file.name,
      status: "UPLOADING",
    },
  });

  try {
    const storagePath = await saveVideoFile({
      projectId,
      videoId: video.id,
      file,
    });

    const updatedVideo = await prisma.video.update({
      where: { id: video.id },
      data: {
        storagePath,
        status: "UPLOADED",
      },
    });

    return Response.json(updatedVideo, { status: 201 });
  } catch {
    await prisma.video.update({
      where: { id: video.id },
      data: { status: "FAILED" },
    });

    return Response.json(
      { error: "Falha ao salvar o vídeo" },
      { status: 500 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos">
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

  const { id: projectId } = await params;

  const project = await getOwnedProject(projectId, session.user.id);

  if (!project) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  const videos = await prisma.video.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });

  return Response.json(videos);
}
