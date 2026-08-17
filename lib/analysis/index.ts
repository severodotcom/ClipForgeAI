import type { ClipAnalyzer } from "./types";
import { mockAnalyzer } from "./mock-analyzer";

const DEFAULT_ANALYZER = "mock";

const ANALYZERS: Record<string, ClipAnalyzer> = {
  mock: mockAnalyzer,
};

export function getClipAnalyzer(): ClipAnalyzer {
  const key = process.env.CLIP_ANALYZER_PROVIDER ?? DEFAULT_ANALYZER;
  const analyzer = ANALYZERS[key];

  if (!analyzer) {
    throw new Error(
      `Analisador de clipes desconhecido: "${key}". Disponíveis: ${Object.keys(ANALYZERS).join(", ")}`
    );
  }

  return analyzer;
}

export type { ClipAnalyzer, ClipSuggestion, TranscriptInput, TranscriptSegment } from "./types";
