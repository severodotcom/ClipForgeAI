// Dedup de trabalho em voo, in-memory, local a este processo — mesma
// família de primitivas de coordenação de lib/concurrency.ts (Semaphore) e
// lib/rate-limit.ts (Map de janelas): adequado para o beta single-instance
// atual, mas NÃO coordena nada entre múltiplas instâncias/processos.
//
// Usado hoje por lib/analysis/openai-analyzer.ts (P2b) para impedir que
// duas requisições concorrentes para a MESMA AnalysisCacheKey (mesmo
// vídeo + mesmo hash de transcrição + mesmo modelo + mesma versão do
// prompt) disparem duas chamadas reais e pagas à OpenAI antes de qualquer
// uma delas gravar o cache. Não é um mutex genérico sobre toda análise:
// chaves diferentes (vídeos diferentes, transcrições diferentes, modelos
// diferentes) nunca se bloqueiam entre si — cada uma tem sua própria
// entrada no Map, independente das outras.
//
// Se este processo rodar em mais de uma instância, cada uma tem seu
// próprio Map: duas requisições para a mesma chave batendo em instâncias
// diferentes ainda disparam duas chamadas reais à OpenAI — isto não
// resolve isso, e não deveria (exigiria um lock distribuído, fora de
// escopo para o beta single-instance). Nesse cenário, a constraint única
// de AnalysisCache (videoId, transcriptHash, model, analyzerVersion)
// continua garantindo que só sobra uma linha de cache no fim, e o
// idempotencyKey de UsageRecord continua garantindo que a quota nunca é
// contada em dobro — só o custo real da chamada duplicada não é evitado
// entre instâncias. Ver auditoria de P2b.
const globalForInFlight = globalThis as unknown as {
  analysisInFlight: Map<string, Promise<unknown>> | undefined;
};

const inFlight =
  globalForInFlight.analysisInFlight ?? (globalForInFlight.analysisInFlight = new Map());

/**
 * Se já existe uma chamada em voo para `key`, retorna a MESMA Promise
 * (o chamador espera e recebe exatamente o mesmo resultado — sucesso ou
 * erro — que quem chegou primeiro). Senão, invoca `run()` agora, guarda a
 * Promise resultante e a retorna.
 *
 * A verificação do Map e o registro da nova entrada acontecem no mesmo
 * bloco síncrono, sem nenhum `await` entre eles: `run()` é chamado
 * sincronamente (só o corpo dele é assíncrono) e a Promise que ele
 * retorna é gravada no Map antes de qualquer ponto de suspensão. Como
 * JavaScript é single-thread, não existe uma janela em que duas chamadas
 * concorrentes possam ambas ver o Map vazio e ambas decidir chamar
 * `run()` — a segunda chamada, mesmo que dispare "ao mesmo tempo", só
 * executa depois que a primeira já terminou de gravar a entrada no Map
 * (mesmo raciocínio já usado em checkRateLimit, lib/rate-limit.ts).
 *
 * A entrada é removida do Map em `finally` — depois que a Promise se
 * resolve OU rejeita, não importa o desfecho. Uma chamada seguinte com a
 * mesma chave, depois disso, começa do zero (nova Promise, nova execução
 * de `run()`), nunca reaproveitando um resultado (ou erro) antigo.
 */
export function dedupeInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);

  if (existing) {
    return existing as Promise<T>;
  }

  const promise = run().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);

  return promise;
}
