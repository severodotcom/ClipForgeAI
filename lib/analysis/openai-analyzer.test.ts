import { describe, expect, it } from "vitest";
import { parseOpenAiResponse } from "./openai-analyzer";

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
