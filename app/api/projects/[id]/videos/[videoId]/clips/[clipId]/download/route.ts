import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { getClipAbsolutePath } from "@/lib/storage";
import { getOwnedClip } from "@/lib/ownership";
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

  const clip = await getOwnedClip(projectId, videoId, clipId, session.user.id);

  if (!clip) {
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
  const range = request.headers.get("range");

  const baseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename="${safeFilename}.mp4"`,
  };

  if (!range) {
    return new Response(Readable.toWeb(createReadStream(absolutePath)) as never, {
      headers: { ...baseHeaders, "Content-Length": size.toString() },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? parseInt(match[1], 10) : 0;
  const end = match?.[2] ? parseInt(match[2], 10) : size - 1;

  if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  return new Response(
    Readable.toWeb(createReadStream(absolutePath, { start, end })) as never,
    {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": (end - start + 1).toString(),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    }
  );
}
