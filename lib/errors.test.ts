import { describe, expect, it } from "vitest";
import { sanitizeFailureReason } from "@/lib/errors";

describe("sanitizeFailureReason (lib/errors.ts)", () => {
  it("extrai message de uma instância de Error", () => {
    expect(sanitizeFailureReason(new Error("ffmpeg exited with code 1"))).toBe(
      "ffmpeg exited with code 1"
    );
  });

  it("converte um valor não-Error via String()", () => {
    expect(sanitizeFailureReason("algo deu errado")).toBe("algo deu errado");
    expect(sanitizeFailureReason(42)).toBe("42");
  });

  it("nunca inclui error.stack — só error.message é lido", () => {
    const error = new Error("falha simples");
    // Simula um stack multilinha real, como o Node geraria.
    error.stack = `Error: falha simples\n    at algumaFuncao (/app/lib/clips.ts:40:5)\n    at outraFuncao (/app/lib/transcription.ts:141:5)`;

    const result = sanitizeFailureReason(error);

    expect(result).toBe("falha simples");
    expect(result).not.toContain("at algumaFuncao");
    expect(result).not.toContain(".ts:");
  });

  it("redige process.cwd() (prefixo de todo caminho absoluto de storage/)", () => {
    const fakePath = `${process.cwd()}/storage/videos/proj1/video1-input.mp4`;
    const error = new Error(`ffmpeg: Input #0, from '${fakePath}': Invalid data found`);

    const result = sanitizeFailureReason(error);

    expect(result).not.toContain(process.cwd());
    expect(result).toContain("<storage>/storage/videos/proj1/video1-input.mp4");
  });

  it("redige substrings que parecem API keys da OpenAI (sk-...)", () => {
    const error = new Error(
      "Falha ao chamar a API da OpenAI: Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz1234567890"
    );

    const result = sanitizeFailureReason(error);

    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result).toContain("[REDACTED]");
  });

  it("colapsa espaços/novas linhas em uma única linha", () => {
    const error = new Error("linha 1\n\n   linha 2\tcom tab");
    expect(sanitizeFailureReason(error)).toBe("linha 1 linha 2 com tab");
  });

  it("trunca mensagens muito longas com um indicador de corte", () => {
    const longMessage = "x".repeat(1000);
    const result = sanitizeFailureReason(new Error(longMessage));

    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.endsWith("…")).toBe(true);
  });

  it("retorna uma mensagem padrão para erro sem conteúdo útil", () => {
    expect(sanitizeFailureReason(new Error(""))).toBe("Falha desconhecida.");
    expect(sanitizeFailureReason(undefined)).toBe("Falha desconhecida.");
  });
});
