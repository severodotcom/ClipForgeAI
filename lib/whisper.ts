import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const WHISPER_MODEL = "Xenova/whisper-base";

const globalForWhisper = globalThis as unknown as {
  whisperPipeline: Promise<AutomaticSpeechRecognitionPipeline> | undefined;
};

export function getWhisperPipeline() {
  if (!globalForWhisper.whisperPipeline) {
    // Chamadas concorrentes que cheguem antes deste `if` resolver de novo
    // compartilham a mesma Promise (nenhum `await` entre a checagem acima
    // e a atribuição abaixo, então não há janela de corrida onde duas
    // chamadas simultâneas disparem pipeline() duas vezes).
    //
    // P2h: se pipeline() rejeitar, o `.catch` abaixo limpa o cache — mas só
    // se `globalForWhisper.whisperPipeline` ainda for exatamente esta
    // Promise (comparação por identidade, não só "existe"). Sem isso, uma
    // falha no primeiro carregamento (ex: modelo corrompido, falta de
    // memória) ficaria cacheada para sempre: toda chamada futura receberia
    // a mesma rejeição, sem nunca tentar carregar o modelo de novo, até o
    // processo reiniciar. O erro original ainda é propagado normalmente
    // para quem está esperando esta chamada — `.catch` aqui só observa e
    // relança, nunca engole a rejeição.
    const loading = pipeline("automatic-speech-recognition", WHISPER_MODEL).catch(
      (error) => {
        if (globalForWhisper.whisperPipeline === loading) {
          globalForWhisper.whisperPipeline = undefined;
        }

        throw error;
      }
    );

    globalForWhisper.whisperPipeline = loading;
  }

  return globalForWhisper.whisperPipeline;
}
