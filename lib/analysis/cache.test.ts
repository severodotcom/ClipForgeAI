import { describe, expect, it } from "vitest";
import { computeTranscriptHash } from "./cache";
import type { TranscriptInput } from "./types";

function transcript(overrides: Partial<TranscriptInput> = {}): TranscriptInput {
  return {
    videoId: "video-1",
    duration: 50,
    text: "irrelevant, hash ignores this field",
    segments: [
      { start: 0, end: 3.5, text: "Olá pessoal" },
      { start: 3.5, end: 8, text: "vamos começar" },
    ],
    ...overrides,
  };
}

describe("computeTranscriptHash", () => {
  it("é determinístico para a mesma transcrição", () => {
    expect(computeTranscriptHash(transcript())).toBe(computeTranscriptHash(transcript()));
  });

  it("muda quando o texto de um segment muda", () => {
    const other = transcript({
      segments: [
        { start: 0, end: 3.5, text: "Olá pessoal, tudo bem?" },
        { start: 3.5, end: 8, text: "vamos começar" },
      ],
    });

    expect(computeTranscriptHash(transcript())).not.toBe(computeTranscriptHash(other));
  });

  it("muda quando start/end mudam", () => {
    const other = transcript({
      segments: [
        { start: 0, end: 4, text: "Olá pessoal" },
        { start: 4, end: 8, text: "vamos começar" },
      ],
    });

    expect(computeTranscriptHash(transcript())).not.toBe(computeTranscriptHash(other));
  });

  it("muda quando duration muda", () => {
    expect(computeTranscriptHash(transcript({ duration: 50 }))).not.toBe(
      computeTranscriptHash(transcript({ duration: 60 }))
    );
  });

  it("ignora diferenças de espaços em branco nas bordas do texto", () => {
    const other = transcript({
      segments: [
        { start: 0, end: 3.5, text: "  Olá pessoal  " },
        { start: 3.5, end: 8, text: "vamos começar" },
      ],
    });

    expect(computeTranscriptHash(transcript())).toBe(computeTranscriptHash(other));
  });

  it("ignora o campo videoId e o texto agregado (text)", () => {
    const other = transcript({ videoId: "video-2", text: "outro texto agregado qualquer" });

    expect(computeTranscriptHash(transcript())).toBe(computeTranscriptHash(other));
  });
});
