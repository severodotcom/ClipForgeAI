import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOwnedVideo } from "@/lib/ownership";
import { getClipAnalyzer, type TranscriptSegment } from "@/lib/analysis";
import { headers } from "next/headers";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/suggestions">
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

  const transcription = await prisma.transcription.findUnique({
    where: { videoId },
  });

  if (!transcription) {
    return Response.json(
      { error: "Vídeo ainda não foi transcrito" },
      { status: 409 }
    );
  }

  const analyzer = getClipAnalyzer();

  const suggestions = await analyzer.analyze({
    videoId,
    duration: video.duration,
    text: transcription.text,
    segments: transcription.segments as unknown as TranscriptSegment[],
  });

  return Response.json({ analyzer: analyzer.name, suggestions });
}
