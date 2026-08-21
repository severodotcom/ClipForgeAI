import { spawn } from "node:child_process";

function runCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }

      resolve(stdout);
    });
  });
}

export async function getAudioDuration(inputPath: string) {
  const stdout = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ]);

  const duration = parseFloat(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      `Não foi possível determinar a duração do vídeo (ffprobe retornou "${stdout.trim()}").`
    );
  }

  return duration;
}

export async function extractAudioWav(inputPath: string, outputPath: string) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    outputPath,
  ]);
}

export async function extractClip(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number
) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-ss",
    startTime.toString(),
    "-to",
    endTime.toString(),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    outputPath,
  ]);
}
