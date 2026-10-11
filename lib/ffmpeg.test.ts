import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock de child_process: nenhum teste aqui dispara um ffmpeg/ffprobe real
// nem espera um timeout de verdade — o tempo é controlado via
// vi.useFakeTimers(), avançado instantaneamente.
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

let currentChild: FakeChildProcess;
const spawnMock = vi.fn(() => currentChild);

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { extractAudioWav, extractClip, getAudioDuration, DEFAULT_TIMEOUT_MS, SIGKILL_GRACE_MS } =
  await import("@/lib/ffmpeg");

describe("runCommand via lib/ffmpeg.ts (P2h) — sem processo real, sem timeout real", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    currentChild = new FakeChildProcess();
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processo termina com sucesso (exit code 0): resolve com o stdout acumulado", async () => {
    const promise = getAudioDuration("/fake/input.mp4");

    currentChild.stdout.emit("data", Buffer.from("12.5"));
    currentChild.emit("close", 0, null);

    await expect(promise).resolves.toBe(12.5);
    expect(currentChild.kill).not.toHaveBeenCalled();
  });

  it("processo termina com erro (exit code != 0): rejeita preservando o stderr real", async () => {
    const promise = extractAudioWav("/fake/input.mp4", "/fake/output.wav");

    currentChild.stderr.emit("data", Buffer.from("Invalid data found when processing input"));
    currentChild.emit("close", 1, null);

    await expect(promise).rejects.toThrow(
      /exited with code 1.*Invalid data found when processing input/
    );
  });

  it("erro de spawn (ex: binário ausente) rejeita com o erro original, sem nunca chegar a 'close'", async () => {
    const promise = extractAudioWav("/fake/input.mp4", "/fake/output.wav");

    const spawnError = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    currentChild.emit("error", spawnError);

    await expect(promise).rejects.toBe(spawnError);

    // Nenhum kill deveria ter sido chamado — nunca houve timeout, o
    // processo nem chegou a existir de fato.
    expect(currentChild.kill).not.toHaveBeenCalled();
  });

  it("timeout: envia SIGTERM após DEFAULT_TIMEOUT_MS; se o processo responder a tempo, rejeita com mensagem de timeout distinta de uma falha normal", async () => {
    const promise = extractClip("/fake/input.mp4", "/fake/output.mp4", 0, 10);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);

    expect(currentChild.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    // Processo responde ao SIGTERM antes da janela de SIGKILL expirar.
    currentChild.stderr.emit("data", Buffer.from("received SIGTERM"));
    currentChild.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow(
      new RegExp(`excedeu o tempo limite de ${DEFAULT_TIMEOUT_MS}ms`)
    );
    await expect(promise).rejects.toThrow(/received SIGTERM/);

    // SIGKILL nunca deveria ter sido necessário neste caso.
    expect(currentChild.kill).toHaveBeenCalledTimes(1);
  });

  it("SIGKILL: se o processo ignorar o SIGTERM, escalona para SIGKILL após SIGKILL_GRACE_MS", async () => {
    const promise = extractClip("/fake/input.mp4", "/fake/output.mp4", 0, 10);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(currentChild.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    // Processo não responde ao SIGTERM dentro da janela de graça.
    await vi.advanceTimersByTimeAsync(SIGKILL_GRACE_MS);
    expect(currentChild.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(currentChild.kill).toHaveBeenCalledTimes(2);

    // Só agora o processo (forçadamente) morre, liberando a Promise.
    currentChild.emit("close", null, "SIGKILL");

    await expect(promise).rejects.toThrow(
      new RegExp(`excedeu o tempo limite de ${DEFAULT_TIMEOUT_MS}ms.*SIGKILL`)
    );
  });

  it("cleanup do timer: um processo que termina normalmente ANTES do timeout nunca sofre kill, mesmo que o tempo avance depois", async () => {
    const promise = getAudioDuration("/fake/input.mp4");

    currentChild.stdout.emit("data", Buffer.from("42.0"));
    currentChild.emit("close", 0, null);

    await expect(promise).resolves.toBe(42.0);

    // Avança bem além do timeout — se o timer não tivesse sido limpo em
    // cleanup(), isto chamaria kill("SIGTERM") num processo que já morreu.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + SIGKILL_GRACE_MS + 1000);

    expect(currentChild.kill).not.toHaveBeenCalled();
  });

  it("stderr é preservado de forma segura: aparece verbatim na mensagem de erro, sem adulteração", async () => {
    const promise = extractAudioWav("/fake/input.mp4", "/fake/output.wav");

    currentChild.stderr.emit("data", Buffer.from("ffmpeg: "));
    currentChild.stderr.emit("data", Buffer.from("codec not supported"));
    currentChild.emit("close", 1, null);

    await expect(promise).rejects.toThrow("ffmpeg: codec not supported");
  });
});
