import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateClip } from "@/lib/clips";
import { getOwnedVideo } from "@/lib/ownership";
import { headers } from "next/headers";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/clips">
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

  const { id: projectId, videoId } = await params;

  const video = await getOwnedVideo(projectId, videoId, session.user.id);

  if (!video) {
    return Response.json(
      { error: "Vídeo não encontrado" },
      { status: 404 }
    );
  }

  const body = await request.json();
  const startTime = Number(body.startTime);
  const endTime = Number(body.endTime);
  const title = typeof body.title === "string" ? body.title.trim() : null;
  const reason = typeof body.reason === "string" ? body.reason.trim() : null;
  const score =
    typeof body.score === "number" && Number.isFinite(body.score)
      ? body.score
      : null;

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

  const clip = await prisma.clip.create({
    data: {
      videoId,
      startTime,
      endTime,
      title: title || null,
      reason: reason || null,
      score,
      status: "PENDING",
    },
  });

  generateClip(clip.id).catch((error) => {
    console.error(`Falha ao iniciar geração do clipe ${clip.id}:`, error);
  });

  return Response.json(clip, { status: 201 });
}
