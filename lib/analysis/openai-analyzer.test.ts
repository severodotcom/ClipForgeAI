import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { AnalysisCacheKey } from "./cache";
import type { TranscriptInput } from "./types";

// P2h: mock do SDK da OpenAI — nenhum teste deste arquivo faz uma chamada
// de rede real. Só os testes do describe "runOpenAiAnalysis" abaixo usam
// isto; os testes de parseOpenAiResponse/mapUsage acima nunca instanciam o
// client, então não são afetados por este mock.
const createMock = vi.fn();

vi.mock("openai", () => ({
  // Função comum, não arrow: `new OpenAI(...)` (em getClient(), ffmpeg-
  // analyzer.ts) precisa de algo invocável como construtor — uma arrow
  // function nunca pode ser (`new (() => {})()` lança "is not a
  // constructor"). Retornar um objeto aqui substitui o `this` padrão,
  // então `new OpenAI(...)` resolve para este objeto mockado.
  default: vi.fn(function MockedOpenAI() {
    return { chat: { completions: { create: createMock } } };
  }),
}));

const { mapUsage, parseOpenAiResponse, runOpenAiAnalysis } = await import("./openai-analyzer");

describe("parseOpenAiResponse", () => {
  it("converte um JSON válido em ClipSuggestion[]", () => {
    const raw = JSON.stringify({
      suggestions: [
        {
          startTime: 12.5,
          endTime: 45.2,
          title: "O segredo da produtividade",
          reason: "Ideia autocontida com gancho forte no início.",
          score: 87,
        },
        {
          startTime: 100,
          endTime: 130,
          title: "Momento engraçado",
          reason: "Reação espontânea e cômica.",
          score: 60,
        },
      ],
    });

    expect(parseOpenAiResponse(raw)).toEqual([
      {
        startTime: 12.5,
        endTime: 45.2,
        title: "O segredo da produtividade",
        reason: "Ideia autocontida com gancho forte no início.",
        score: 87,
      },
      {
        startTime: 100,
        endTime: 130,
        title: "Momento engraçado",
        reason: "Reação espontânea e cômica.",
        score: 60,
      },
    ]);
  });

  it("aceita uma lista de sugestões vazia", () => {
    expect(parseOpenAiResponse(JSON.stringify({ suggestions: [] }))).toEqual([]);
  });

  it("lança erro para conteúdo vazio ou ausente", () => {
    expect(() => parseOpenAiResponse("")).toThrow();
    expect(() => parseOpenAiResponse(null)).toThrow();
    expect(() => parseOpenAiResponse(undefined)).toThrow();
    expect(() => parseOpenAiResponse("   ")).toThrow();
  });

  it("lança erro para JSON malformado", () => {
    expect(() => parseOpenAiResponse("{ isso não é json")).toThrow(
      "Resposta da OpenAI não é um JSON válido."
    );
  });

  it("lança erro quando a raiz não é um objeto", () => {
    expect(() => parseOpenAiResponse("[]")).toThrow(
      "Resposta da OpenAI não é um objeto JSON."
    );
    expect(() => parseOpenAiResponse('"apenas uma string"')).toThrow(
      "Resposta da OpenAI não é um objeto JSON."
    );
  });

  it("lança erro quando 'suggestions' não é um array", () => {
    expect(() => parseOpenAiResponse(JSON.stringify({ suggestions: "nada" }))).toThrow(
      "Resposta da OpenAI não contém um array 'suggestions'."
    );
    expect(() => parseOpenAiResponse(JSON.stringify({}))).toThrow(
      "Resposta da OpenAI não contém um array 'suggestions'."
    );
  });

  it("lança erro quando uma sugestão não é um objeto", () => {
    expect(() =>
      parseOpenAiResponse(JSON.stringify({ suggestions: ["trecho qualquer"] }))
    ).toThrow("Sugestão #0 da OpenAI não é um objeto válido.");
  });

  it("lança erro quando startTime/endTime estão ausentes ou inválidos", () => {
    const base = { title: "T", reason: "R", score: 50 };

    expect(() =>
      parseOpenAiResponse(JSON.stringify({ suggestions: [{ ...base, endTime: 10 }] }))
    ).toThrow("Sugestão #0 da OpenAI tem startTime inválido.");

    expect(() =>
      parseOpenAiResponse(
        JSON.stringify({ suggestions: [{ ...base, startTime: 0, endTime: "10" }] })
      )
    ).toThrow("Sugestão #0 da OpenAI tem endTime inválido.");

    expect(() =>
      parseOpenAiResponse(
        JSON.stringify({ suggestions: [{ ...base, startTime: NaN, endTime: 10 }] })
      )
    ).toThrow("Sugestão #0 da OpenAI tem startTime inválido.");
  });

  it("lança erro quando title/reason estão ausentes, vazios ou não são string", () => {
    const base = { startTime: 0, endTime: 10, score: 50 };

    expect(() =>
      parseOpenAiResponse(JSON.stringify({ suggestions: [{ ...base, reason: "R" }] }))
    ).toThrow("Sugestão #0 da OpenAI tem title inválido.");

    expect(() =>
      parseOpenAiResponse(
        JSON.stringify({ suggestions: [{ ...base, title: "  ", reason: "R" }] })
      )
    ).toThrow("Sugestão #0 da OpenAI tem title inválido.");

    expect(() =>
      parseOpenAiResponse(JSON.stringify({ suggestions: [{ ...base, title: "T" }] }))
    ).toThrow("Sugestão #0 da OpenAI tem reason inválido.");
  });

  it("lança erro quando score está ausente ou não é um número finito", () => {
    const base = { startTime: 0, endTime: 10, title: "T", reason: "R" };

    expect(() =>
      parseOpenAiResponse(JSON.stringify({ suggestions: [{ ...base }] }))
    ).toThrow("Sugestão #0 da OpenAI tem score inválido.");

    expect(() =>
      parseOpenAiResponse(
        JSON.stringify({ suggestions: [{ ...base, score: "alto" }] })
      )
    ).toThrow("Sugestão #0 da OpenAI tem score inválido.");
  });

  it("identifica o índice correto quando um item no meio da lista é inválido", () => {
    const valid = { startTime: 0, endTime: 10, title: "T", reason: "R", score: 50 };

    expect(() =>
      parseOpenAiResponse(
        JSON.stringify({ suggestions: [valid, { ...valid, title: "" }, valid] })
      )
    ).toThrow("Sugestão #1 da OpenAI tem title inválido.");
  });
});

describe("mapUsage", () => {
  it("converte completion.usage em OpenAiUsage", () => {
    expect(
      mapUsage({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 })
    ).toEqual({ promptTokens: 120, completionTokens: 45, totalTokens: 165 });
  });

  it("retorna null quando usage está ausente", () => {
    expect(mapUsage(null)).toBeNull();
    expect(mapUsage(undefined)).toBeNull();
  });
});

describe("runOpenAiAnalysis — rejeições do SDK/API (P2h)", () => {
  const runId = randomUUID();
  const FAKE_API_KEY = "sk-test-fake-key-never-real-1234567890";
  let userId: string;
  let videoId: string;

  // AnalysisCache.videoId é FK obrigatória para Video (onDelete: Cascade) —
  // mesmo os testes de falha (que nunca chegam a escrever cache) usam um
  // vídeo real aqui, para que o único teste de sucesso abaixo (que escreve
  // de verdade) não viole a constraint.
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `openai-failure-test-${runId}@clipforge.test`, name: "OpenAI Failure Test" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { userId, name: "Projeto teste de falha OpenAI" },
    });

    const video = await prisma.video.create({
      data: { projectId: project.id, originalFilename: "v.mp4", status: "UPLOADED", duration: 50 },
    });
    videoId = video.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  function makeTranscript(): TranscriptInput {
    return {
      videoId,
      duration: 50,
      text: "Olá pessoal, hoje vamos falar de um assunto importante.",
      segments: [{ start: 0, end: 10, text: "Olá pessoal, hoje vamos falar de um assunto importante." }],
    };
  }

  function makeCacheKey(): AnalysisCacheKey {
    return {
      videoId,
      transcriptHash: `fake-hash-${randomUUID()}`,
      model: "gpt-4o-mini",
      analyzerVersion: "openai-suggestions-v1",
    };
  }

  async function expectNoCacheRowCreated(cacheKey: AnalysisCacheKey) {
    const rows = await prisma.analysisCache.findMany({ where: { videoId: cacheKey.videoId } });
    expect(rows).toHaveLength(0);
  }

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", FAKE_API_KEY);
    vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
    createMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("erro de rede/genérico: rejeita com mensagem segura, sem expor a API key", async () => {
    createMock.mockRejectedValueOnce(new Error("fetch failed"));
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    await expect(runOpenAiAnalysis(transcript, cacheKey)).rejects.toThrow(
      "Falha ao chamar a API da OpenAI: fetch failed"
    );

    await expectNoCacheRowCreated(cacheKey);
  });

  it("401 (API key inválida): rejeita de forma segura, sem ecoar a chave de volta", async () => {
    const sdkError = Object.assign(
      new Error("401 Incorrect API key provided: sk-test***7890."),
      { status: 401 }
    );
    createMock.mockRejectedValueOnce(sdkError);
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    let thrown: unknown;
    try {
      await runOpenAiAnalysis(transcript, cacheKey);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Falha ao chamar a API da OpenAI");
    // A key completa usada nesta chamada (via env) nunca deveria aparecer
    // na mensagem propagada — só o fragmento mascarado que o próprio SDK
    // (simulado aqui) já retornaria, nunca o valor real configurado.
    expect(message).not.toContain(FAKE_API_KEY);

    await expectNoCacheRowCreated(cacheKey);
  });

  it("429 (rate limit da OpenAI): distinguível na mensagem, não confundido com outra falha", async () => {
    const sdkError = Object.assign(
      new Error("Rate limit reached for requests. Please try again later."),
      { status: 429 }
    );
    createMock.mockRejectedValueOnce(sdkError);
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    await expect(runOpenAiAnalysis(transcript, cacheKey)).rejects.toThrow(/Rate limit reached/);

    await expectNoCacheRowCreated(cacheKey);
  });

  it("500 (erro interno da OpenAI): rejeita de forma segura", async () => {
    const sdkError = Object.assign(
      new Error("The server had an error processing your request."),
      { status: 500 }
    );
    createMock.mockRejectedValueOnce(sdkError);
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    await expect(runOpenAiAnalysis(transcript, cacheKey)).rejects.toThrow(
      "Falha ao chamar a API da OpenAI: The server had an error processing your request."
    );

    await expectNoCacheRowCreated(cacheKey);
  });

  it("resposta com conteúdo inválido (não-JSON): rejeita via parseOpenAiResponse, sem persistir cache", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: "isto não é JSON" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    await expect(runOpenAiAnalysis(transcript, cacheKey)).rejects.toThrow(
      "Resposta da OpenAI não é um JSON válido."
    );

    await expectNoCacheRowCreated(cacheKey);
  });

  it("resposta sem conteúdo: rejeita com mensagem clara, sem persistir cache", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: null,
    });
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    await expect(runOpenAiAnalysis(transcript, cacheKey)).rejects.toThrow(
      "Resposta vazia da OpenAI: nenhum conteúdo retornado."
    );

    await expectNoCacheRowCreated(cacheKey);
  });

  it("chamada bem-sucedida continua funcionando normalmente (comportamento de sucesso não foi alterado)", async () => {
    createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              suggestions: [
                { startTime: 0, endTime: 8, title: "Título", reason: "Motivo", score: 90 },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    const transcript = makeTranscript();
    const cacheKey = makeCacheKey();

    const result = await runOpenAiAnalysis(transcript, cacheKey);

    expect(result.suggestions).toHaveLength(1);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });

    const rows = await prisma.analysisCache.findMany({ where: { videoId: cacheKey.videoId } });
    expect(rows).toHaveLength(1);

    await prisma.analysisCache.deleteMany({ where: { videoId: cacheKey.videoId } });
  });
});
