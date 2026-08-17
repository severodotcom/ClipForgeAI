import type { ClipAnalyzer, ClipSuggestion, TranscriptInput, TranscriptSegment } from "./types";

const TARGET_WINDOW_SECONDS = 25;
const MAX_SUGGESTIONS = 5;
const IDEAL_WORD_COUNT = 40;

const KEYWORDS = [
  "incrível",
  "importante",
  "nunca",
  "sempre",
  "segredo",
  "dica",
  "cuidado",
  "atenção",
  "erro",
  "sucesso",
  "resultado",
];

function buildWindows(segments: TranscriptSegment[]) {
  const windows: TranscriptSegment[][] = [];
  let bucket: TranscriptSegment[] = [];

  for (const segment of segments) {
    if (!segment.text.trim() || segment.end <= segment.start) continue;

    bucket.push(segment);

    const windowStart = bucket[0].start;
    if (segment.end - windowStart >= TARGET_WINDOW_SECONDS) {
      windows.push(bucket);
      bucket = [];
    }
  }

  if (bucket.length > 0) {
    windows.push(bucket);
  }

  return windows;
}

function deriveTitle(text: string) {
  const words = text.trim().split(/\s+/);
  const snippet = words.slice(0, 8).join(" ");
  const capitalized = snippet.charAt(0).toUpperCase() + snippet.slice(1);
  return words.length > 8 ? `${capitalized}…` : capitalized;
}

function scoreAndExplain(text: string, wordCount: number, durationSeconds: number) {
  const lowerText = text.toLowerCase();
  const keywordHits = KEYWORDS.filter((keyword) => lowerText.includes(keyword)).length;
  const punctuationHits = (text.match(/[!?]/g) ?? []).length;
  const durationFit = durationSeconds >= 10 && durationSeconds <= 60 ? 1 : 0.5;

  const lengthScore = Math.min(wordCount / IDEAL_WORD_COUNT, 1);
  const keywordScore = Math.min(keywordHits / 3, 1);
  const punctuationScore = Math.min(punctuationHits / 2, 1);

  const score =
    Math.round(
      (lengthScore * 0.35 +
        keywordScore * 0.35 +
        punctuationScore * 0.15 +
        durationFit * 0.15) *
        100
    ) / 100;

  const reasonParts = [`${wordCount} palavra(s) em ${durationSeconds.toFixed(0)}s`];
  if (keywordHits > 0) reasonParts.push(`${keywordHits} termo(s) de destaque`);
  if (punctuationHits > 0) {
    reasonParts.push(`tom enfático (${punctuationHits} pontuação(ões) forte(s))`);
  }

  return {
    score,
    reason: `Candidato heurístico (mock): ${reasonParts.join(", ")}.`,
  };
}

export const mockAnalyzer: ClipAnalyzer = {
  name: "mock-heuristic",

  async analyze(transcript: TranscriptInput): Promise<ClipSuggestion[]> {
    const windows = buildWindows(transcript.segments);

    const suggestions = windows.map((window) => {
      const text = window
        .map((segment) => segment.text.trim())
        .join(" ")
        .trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const startTime = window[0].start;
      const endTime = window[window.length - 1].end;
      const { score, reason } = scoreAndExplain(text, wordCount, endTime - startTime);

      return {
        startTime,
        endTime,
        title: deriveTitle(text),
        reason,
        score,
      };
    });

    return suggestions.sort((a, b) => b.score - a.score).slice(0, MAX_SUGGESTIONS);
  },
};
