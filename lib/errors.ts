// Transforma um erro qualquer (ffmpeg, Whisper, filesystem, etc.) numa
// mensagem curta e segura para persistir em Video.errorMessage/
// Clip.errorMessage (P2h) — segura o suficiente para também ser devolvida
// ao frontend sem sanitização adicional, já que é a mesma string em ambos
// os casos (ver app/dashboard/.../VideoList.tsx).
//
// Garantias:
// - Nunca usa `error.stack` — só `error.message` (ou `String(error)` para
//   algo que não é um Error), então nenhum stack trace chega a este ponto.
// - Redige qualquer ocorrência do diretório de trabalho do processo
//   (process.cwd(), que é o prefixo de todo caminho absoluto construído em
//   lib/storage.ts via path.join(process.cwd(), "storage", ...)) — cobre o
//   caso real em que o stderr do ffmpeg inclui o caminho completo do
//   arquivo de entrada/saída (extractAudioWav/extractClip não passam
//   `-v error`, então o banner padrão do ffmpeg ecoa esses caminhos).
// - Redige qualquer substring que pareça uma API key da OpenAI
//   (`sk-...`), como defesa adicional — nenhum ponto de chamada atual
//   deveria produzir isso, mas é uma rede de segurança barata.
// - Limita o tamanho final, para nunca persistir um texto sem limite.
const MAX_LENGTH = 500;
const STORAGE_ROOT = process.cwd();
const OPENAI_KEY_PATTERN = /sk-[A-Za-z0-9_-]{10,}/g;

export function sanitizeFailureReason(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : error == null ? "" : String(error);

  const withoutPaths = raw.split(STORAGE_ROOT).join("<storage>");
  const withoutKeys = withoutPaths.replace(OPENAI_KEY_PATTERN, "[REDACTED]");
  const collapsed = withoutKeys.replace(/\s+/g, " ").trim();

  if (!collapsed) {
    return "Falha desconhecida.";
  }

  return collapsed.length > MAX_LENGTH
    ? `${collapsed.slice(0, MAX_LENGTH - 1)}…`
    : collapsed;
}
