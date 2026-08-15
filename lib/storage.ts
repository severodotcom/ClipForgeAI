import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const VIDEO_STORAGE_ROOT = path.join(process.cwd(), "storage", "videos");

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

export async function saveVideoFile({
  projectId,
  videoId,
  file,
}: {
  projectId: string;
  videoId: string;
  file: File;
}) {
  const projectDir = path.join(VIDEO_STORAGE_ROOT, projectId);
  await mkdir(projectDir, { recursive: true });

  const safeName = `${videoId}-${sanitizeFilename(file.name)}`;
  const absolutePath = path.join(projectDir, safeName);

  await pipeline(
    Readable.fromWeb(file.stream() as never),
    createWriteStream(absolutePath)
  );

  return path.join(projectId, safeName);
}
