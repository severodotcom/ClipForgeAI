import { auth } from "@/lib/auth";
import { retryClip } from "@/lib/retry";
import { headers } from "next/headers";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/clips/[clipId]/retry">
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

  const result = await retryClip(projectId, videoId, clipId, session.user.id);

  switch (result.outcome) {
    case "not_found":
      return Response.json(
        { error: "Clipe não encontrado" },
        { status: 404 }
      );

    case "not_failed":
      return Response.json(
        {
          error: "Somente clipes com falha podem ser repetidos.",
          code: "NOT_FAILED",
          status: result.clip.status,
        },
        { status: 409 }
      );

    case "started":
      return Response.json(result.clip, { status: 200 });
  }
}
