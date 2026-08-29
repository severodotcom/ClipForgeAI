// Semáforo in-memory, local a este processo Node — NÃO coordena nada entre
// instâncias/processos. É um limitador simples para o beta single-instance;
// quando houver mais de uma instância rodando, isso precisa ser substituído
// por uma fila real (worker/job queue) ou um lock distribuído (ex: Redis).
//
// Objetivo: nunca ter mais de N execuções pesadas (Whisper, ffmpeg) rodando
// ao mesmo tempo neste processo — mesmo que várias requisições cheguem
// juntas. Quem chega e não tem slot livre fica na fila e é liberado em
// ordem de chegada (FIFO) quando o slot anterior é devolvido.
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Repassa o slot direto para quem está esperando, sem nunca
      // incrementar `available` — evita que um `release()` extra acidental
      // "vaze" capacidade para além do limite configurado.
      next();
      return;
    }

    this.available += 1;
  }

  // `fn` é uma função que *cria* a promise pesada, não a promise já criada
  // — isso é essencial: a execução real só começa depois de `acquire()`
  // resolver, então uma chamada que está esperando sua vez não dispara
  // Whisper/ffmpeg em paralelo, só quando o slot é liberado.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      // Roda em sucesso, erro OU rejeição por timeout — `fn` sempre passa
      // por um await aqui dentro, então qualquer desfecho cai neste
      // `finally` e libera o slot para a próxima tarefa da fila.
      this.release();
    }
  }
}

const globalForConcurrency = globalThis as unknown as {
  whisperSemaphore: Semaphore | undefined;
  clipSemaphore: Semaphore | undefined;
};

// No máximo 1 transcrição Whisper rodando por vez neste processo.
export const whisperSemaphore =
  globalForConcurrency.whisperSemaphore ?? (globalForConcurrency.whisperSemaphore = new Semaphore(1));

// No máximo 1 geração de clipe (ffmpeg) rodando por vez neste processo.
export const clipSemaphore =
  globalForConcurrency.clipSemaphore ?? (globalForConcurrency.clipSemaphore = new Semaphore(1));
