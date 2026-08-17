import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const VIDEO_STORAGE_ROOT = path.join(process.cwd(), "storage", "videos");
const CLIP_STORAGE_ROOT = path.join(process.cwd(), "storage", "clips");

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

export function getVideoAbsolutePath(storagePath: string) {
  return path.join(VIDEO_STORAGE_ROOT, storagePath);
}

export async function prepareClipOutputPath({
  projectId,
  videoId,
  clipId,
}: {
  projectId: string;
  videoId: string;
  clipId: string;
}) {
  const dir = path.join(CLIP_STORAGE_ROOT, projectId, videoId);
  await mkdir(dir, { recursive: true });

  const relativePath = path.join(projectId, videoId, `${clipId}.mp4`);

  return {
    relativePath,
    absolutePath: path.join(CLIP_STORAGE_ROOT, relativePath),
  };
}

export function getClipAbsolutePath(storagePath: string) {
  return path.join(CLIP_STORAGE_ROOT, storagePath);
}
