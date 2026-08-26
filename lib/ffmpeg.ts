import { spawn } from "node:child_process";

// Bounds how long a single ffmpeg/ffprobe invocation may run before it's
// considered stuck and killed. Overridable via env for hosts with unusually
// large/slow files; the default covers ffprobe (near-instant), audio
// extraction (roughly real-time) and clip re-encoding (short segments) with
// comfortable margin.
const DEFAULT_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS) || 10 * 60 * 1000;

// Grace period after SIGTERM before escalating to SIGKILL, for a process
// that ignores/can't act on the polite signal.
const SIGKILL_GRACE_MS = 5000;

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimeoutId: NodeJS.Timeout | undefined;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      killTimeoutId = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    function cleanup() {
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(killTimeoutId);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("close", (code, signal) => {
      cleanup();

      if (timedOut) {
        reject(
          new Error(
            `${command} excedeu o tempo limite de ${timeoutMs}ms e foi encerrado (${signal ?? "sem sinal"}): ${stderr}`
          )
        );
        return;
      }

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
