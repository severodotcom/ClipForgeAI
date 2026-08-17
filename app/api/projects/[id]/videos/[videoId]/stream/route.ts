import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { getVideoAbsolutePath } from "@/lib/storage";
import { getOwnedVideo } from "@/lib/ownership";
import { headers } from "next/headers";

const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

function guessMimeType(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "video/mp4";
}

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/stream">
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

  if (!video || !video.storagePath) {
    return Response.json(
      { error: "Vídeo não encontrado" },
      { status: 404 }
    );
  }

  const absolutePath = getVideoAbsolutePath(video.storagePath);
  const { size } = await stat(absolutePath);
  const contentType = guessMimeType(video.originalFilename);
  const range = request.headers.get("range");

  const baseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
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
