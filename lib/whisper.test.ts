import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock da própria dependência pesada — nenhum teste aqui baixa ou carrega
// um modelo real. `pipeline` é a única exportação de @huggingface/
// transformers que lib/whisper.ts usa.
const pipelineMock = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

// Import estático: getWhisperPipeline não guarda nenhum estado no escopo
// do módulo (só em globalThis, resetado manualmente abaixo), então
// reimportar o mesmo módulo cacheado entre testes é seguro — não precisa
// de vi.resetModules()/import dinâmico por teste.
const { getWhisperPipeline } = await import("@/lib/whisper");

/**
 * `globalForWhisper.whisperPipeline` (lib/whisper.ts) vive em `globalThis`,
 * não no escopo do módulo — então nem `vi.resetModules()` o reseta entre
 * testes. Precisa ser limpo manualmente, senão o cache de um teste
 * contamina o próximo.
 */
function resetWhisperGlobalCache() {
  delete (globalThis as { whisperPipeline?: unknown }).whisperPipeline;
}

describe("getWhisperPipeline (lib/whisper.ts) — P2h", () => {
  beforeEach(() => {
    resetWhisperGlobalCache();
    pipelineMock.mockReset();
  });

  afterEach(() => {
    resetWhisperGlobalCache();
  });

  it("carregamento bem-sucedido é cacheado — chamadas seguintes não invocam pipeline() de novo", async () => {
    const fakePipeline = { id: "fake-pipeline-instance" };
    pipelineMock.mockResolvedValueOnce(fakePipeline);

    const first = await getWhisperPipeline();
    const second = await getWhisperPipeline();
    const third = await getWhisperPipeline();

    expect(first).toBe(fakePipeline);
    expect(second).toBe(fakePipeline);
    expect(third).toBe(fakePipeline);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("chamadas concorrentes (antes do carregamento resolver) compartilham a mesma Promise — pipeline() é chamado só uma vez", async () => {
    let resolveLoad!: (value: unknown) => void;
    pipelineMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        })
    );

    const promiseA = getWhisperPipeline();
    const promiseB = getWhisperPipeline();

    // Mesma Promise, não só o mesmo valor eventual — prova que a segunda
    // chamada reutilizou o carregamento em andamento, em vez de iniciar um
    // segundo.
    expect(promiseA).toBe(promiseB);
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    const fakePipeline = { id: "fake-pipeline-instance" };
    resolveLoad(fakePipeline);

    await expect(promiseA).resolves.toBe(fakePipeline);
    await expect(promiseB).resolves.toBe(fakePipeline);
  });

  it("primeiro carregamento falha: a rejeição original é propagada sem ser engolida", async () => {
    const originalError = new Error("falha ao carregar o modelo Whisper");
    pipelineMock.mockRejectedValueOnce(originalError);

    await expect(getWhisperPipeline()).rejects.toBe(originalError);
  });

  it("após uma falha, a próxima chamada tenta carregar de novo (não fica com a Promise rejeitada cacheada para sempre)", async () => {
    pipelineMock.mockRejectedValueOnce(new Error("primeira tentativa falhou"));

    await expect(getWhisperPipeline()).rejects.toThrow("primeira tentativa falhou");

    // Sem a correção do P2h, esta segunda chamada reutilizaria a mesma
    // Promise já rejeitada, sem nunca invocar pipeline() de novo.
    const fakePipeline = { id: "fake-pipeline-instance" };
    pipelineMock.mockResolvedValueOnce(fakePipeline);

    await expect(getWhisperPipeline()).resolves.toBe(fakePipeline);
    expect(pipelineMock).toHaveBeenCalledTimes(2);

    // E o sucesso subsequente volta a ser cacheado normalmente.
    await expect(getWhisperPipeline()).resolves.toBe(fakePipeline);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it("falhas concorrentes (duas chamadas esperando o mesmo carregamento que rejeita) recebem o mesmo erro, e a chamada seguinte tenta de novo", async () => {
    let rejectLoad!: (error: unknown) => void;
    pipelineMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        })
    );

    const promiseA = getWhisperPipeline();
    const promiseB = getWhisperPipeline();
    expect(promiseA).toBe(promiseB);

    const originalError = new Error("modelo corrompido");
    rejectLoad(originalError);

    await expect(promiseA).rejects.toBe(originalError);
    await expect(promiseB).rejects.toBe(originalError);
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    const fakePipeline = { id: "fake-pipeline-instance" };
    pipelineMock.mockResolvedValueOnce(fakePipeline);

    await expect(getWhisperPipeline()).resolves.toBe(fakePipeline);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });
});
