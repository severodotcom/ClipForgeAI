import { rm } from "node:fs/promises";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateClip } from "@/lib/clips";
import { deleteClipFile, getClipAbsolutePath } from "@/lib/storage";
import { getOwnedClip } from "@/lib/ownership";
import { checkRateLimit, rateLimitKey, rateLimitResponse, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { headers } from "next/headers";

const MAX_TITLE_LENGTH = 200;

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
  const body = await request.json();

  const wantsNewRange =
    body.startTime !== undefined || body.endTime !== undefined;

  // P2a: rate limit checado antes de ownership/query/processamento — mas só
  // quando este PATCH de fato vai disparar ffmpeg (mudança de intervalo).
  // Um PATCH que só edita o título não consome deste orçamento, que é
  // compartilhado com a criação de clipe (mesma chave "clip-generation").
  if (wantsNewRange) {
    const rateDecision = checkRateLimit(
      rateLimitKey("clip-generation", session.user.id),
      RATE_LIMIT_RULES.CLIP_GENERATION
    );

    if (!rateDecision.allowed) {
      return rateLimitResponse(rateDecision);
    }
  }

  const clip = await getOwnedClip(projectId, videoId, clipId, session.user.id);

  if (!clip) {
    return Response.json(
      { error: "Clipe não encontrado" },
      { status: 404 }
    );
  }

  const data: {
    title?: string | null;
    startTime?: number;
    endTime?: number;
    status?: "PENDING";
    outputPath?: null;
    errorMessage?: null;
  } = {};

  if (typeof body.title === "string") {
    data.title = body.title.trim().slice(0, MAX_TITLE_LENGTH) || null;
  }

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
    // P2h: mesma decisão do retry (lib/retry.ts) — editar o intervalo
    // dispara reprocessamento, então o erro de uma geração anterior deixa
    // de ser relevante para o estado atual.
    data.errorMessage = null;
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

  // P2g: rate limit antes de ownership/storage/banco — mesmo padrão de
  // upload/retry/clip-generation (P2a).
  const rateDecision = checkRateLimit(
    rateLimitKey("clip-delete", session.user.id),
    RATE_LIMIT_RULES.CLIP_DELETE
  );

  if (!rateDecision.allowed) {
    return rateLimitResponse(rateDecision);
  }

  const { id: projectId, videoId, clipId } = await params;

  const clip = await getOwnedClip(projectId, videoId, clipId, session.user.id);

  if (!clip) {
    return Response.json(
      { error: "Clipe não encontrado" },
      { status: 404 }
    );
  }

  if (clip.status === "GENERATING") {
    return Response.json(
      {
        error: "O clipe está sendo gerado e não pode ser excluído agora.",
        code: "CLIP_PROCESSING",
      },
      { status: 409 }
    );
  }

  try {
    if (clip.outputPath) {
      await deleteClipFile(clip.outputPath);
    }
  } catch (error) {
    // Erro real de filesystem (não ENOENT) — aborta antes de tocar o
    // banco; diferente do comportamento anterior, que engolia qualquer
    // erro de rm() indiscriminadamente.
    console.error(`Falha ao remover o arquivo físico do clipe ${clipId}:`, error);

    return Response.json(
      { error: "Falha ao remover o arquivo do clipe" },
      { status: 500 }
    );
  }

  // Exclusão condicional e atômica — mesmo padrão de lib/retry.ts: se o
  // clipe voltou a GENERATING (ex: retry concorrente) entre a checagem
  // acima e este delete, count fica 0 e a linha não é apagada.
  const result = await prisma.clip.deleteMany({
    where: {
      id: clipId,
      videoId,
      status: { not: "GENERATING" },
    },
  });

  if (result.count === 0) {
    const stillExists = await prisma.clip.findUnique({ where: { id: clipId } });

    if (!stillExists) {
      return Response.json(
        { error: "Clipe não encontrado" },
        { status: 404 }
      );
    }

    console.error(
      `Clipe ${clipId} voltou a GENERATING durante a exclusão; arquivo já removido, linha mantida.`
    );

    return Response.json(
      {
        error: "O clipe entrou em geração durante a exclusão. Tente novamente.",
        code: "CLIP_PROCESSING",
      },
      { status: 409 }
    );
  }

  return new Response(null, { status: 204 });
}
