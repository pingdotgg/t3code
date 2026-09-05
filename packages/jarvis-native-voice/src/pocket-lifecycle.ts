export type PocketChunkConsumer = (path: string, index: number) => Promise<void>;

export type PocketSynthesisMetrics = {
  readonly chunkCount: number;
  readonly totalSamples: number;
  readonly sampleRate: number;
  readonly synthesisDurationMs: number;
  readonly synthesisCpuMs: number;
  readonly peakRssBytes: number;
  readonly firstChunkReadyMs?: number;
};

export type PocketWorker = {
  readonly synthesize: (
    text: string,
    consumeChunk: PocketChunkConsumer,
    signal?: AbortSignal,
  ) => Promise<PocketSynthesisMetrics>;
  readonly close: () => Promise<void>;
};

export type PocketLifecycleState = "offloaded" | "warming" | "ready" | "synthesizing";

export type PocketLifecycle = {
  readonly prewarm: (signal?: AbortSignal) => Promise<void>;
  readonly synthesize: (
    text: string,
    consumeChunk: PocketChunkConsumer,
    signal?: AbortSignal,
  ) => Promise<PocketSynthesisMetrics & { readonly cold: boolean; readonly warmupMs?: number }>;
  readonly setRetention: (retained: boolean) => void;
  readonly interrupt: () => void;
  readonly dispose: () => Promise<void>;
  readonly state: () => PocketLifecycleState;
};

export type PocketLifecycleScheduler = (delayMs: number, task: () => void) => () => void;

export function createPocketLifecycle(options: {
  readonly startWorker: (signal?: AbortSignal) => Promise<PocketWorker>;
  readonly schedule: PocketLifecycleScheduler;
  readonly idleMs: number;
}): PocketLifecycle {
  let lifecycleState: PocketLifecycleState = "offloaded";
  let generation = 0;
  let worker: PocketWorker | undefined;
  let warming: Promise<PocketWorker> | undefined;
  let warmingAbort: AbortController | undefined;
  let closing: Promise<void> | undefined;
  let cancelEviction: (() => void) | undefined;
  let activeReject: ((cause: Error) => void) | undefined;
  let retained = false;

  const closeWorker = async (expectedGeneration?: number) => {
    if (expectedGeneration !== undefined && expectedGeneration !== generation) return;
    if (worker === undefined && warming === undefined && closing !== undefined) {
      await closing;
      return;
    }
    cancelEviction?.();
    cancelEviction = undefined;
    generation += 1;
    const pendingWarm = warming;
    warmingAbort?.abort();
    warmingAbort = undefined;
    warming = undefined;
    const current = worker;
    worker = undefined;
    lifecycleState = "offloaded";
    activeReject?.(new DOMException("Jarvis speech was interrupted.", "AbortError"));
    activeReject = undefined;
    const close = current?.close();
    const waitForWarm = pendingWarm?.then(
      (started) => started.close(),
      () => undefined,
    );
    if (close !== undefined || waitForWarm !== undefined) {
      const closePromise = Promise.all([close, waitForWarm]).then(
        () => undefined,
        () => undefined,
      );
      closing = closePromise;
      await closePromise;
      if (closing === closePromise) closing = undefined;
    }
  };

  const scheduleEviction = () => {
    cancelEviction?.();
    if (retained) {
      cancelEviction = undefined;
      return;
    }
    const expectedGeneration = generation;
    cancelEviction = options.schedule(options.idleMs, () => {
      void closeWorker(expectedGeneration);
    });
  };

  const prewarm = async (signal?: AbortSignal) => {
    if (signal?.aborted) {
      throw new DOMException("Jarvis speech was interrupted.", "AbortError");
    }
    cancelEviction?.();
    cancelEviction = undefined;
    if (closing !== undefined) await closing;
    if (signal?.aborted) {
      throw new DOMException("Jarvis speech was interrupted.", "AbortError");
    }
    if (worker !== undefined) {
      if (lifecycleState === "ready") scheduleEviction();
      return;
    }
    if (warming !== undefined) {
      await warming;
      return;
    }
    lifecycleState = "warming";
    const expectedGeneration = generation;
    const startAbort = new AbortController();
    warmingAbort = startAbort;
    const onAbort = () => startAbort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const pending = options.startWorker(startAbort.signal);
    warming = pending;
    try {
      const started = await pending;
      if (generation !== expectedGeneration || signal?.aborted) {
        await started.close().catch(() => undefined);
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      worker = started;
      lifecycleState = "ready";
      scheduleEviction();
    } catch (cause) {
      if (generation === expectedGeneration) lifecycleState = "offloaded";
      throw cause;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (warming === pending) warming = undefined;
      if (warmingAbort === startAbort) warmingAbort = undefined;
    }
  };

  return {
    prewarm,
    setRetention(retainedValue) {
      retained = retainedValue;
      if (retainedValue) {
        cancelEviction?.();
        cancelEviction = undefined;
      } else if (worker !== undefined && lifecycleState === "ready") {
        scheduleEviction();
      }
    },
    async synthesize(text, consumeChunk, signal) {
      if (signal?.aborted) {
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      const wasWarm = worker !== undefined;
      const warmupStartedAt = performance.now();
      await prewarm(signal);
      const warmupMs = wasWarm ? undefined : performance.now() - warmupStartedAt;
      if (signal?.aborted) {
        await closeWorker();
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      const current = worker;
      if (current === undefined) throw new Error("Pocket did not finish warming.");
      cancelEviction?.();
      cancelEviction = undefined;
      lifecycleState = "synthesizing";
      const expectedGeneration = generation;
      let removeAbort: () => void = () => undefined;
      let ownReject: ((cause: Error) => void) | undefined;
      try {
        const result = await new Promise<PocketSynthesisMetrics>((resolve, reject) => {
          ownReject = reject;
          activeReject = reject;
          const onAbort = () => {
            void closeWorker(expectedGeneration);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal?.removeEventListener("abort", onAbort);
          void current.synthesize(text, consumeChunk, signal).then(resolve, reject);
        });
        return {
          ...result,
          cold: !wasWarm,
          ...(warmupMs === undefined ? {} : { warmupMs }),
        };
      } catch (cause) {
        await closeWorker(expectedGeneration);
        throw cause;
      } finally {
        removeAbort();
        if (activeReject === ownReject) activeReject = undefined;
        if (generation === expectedGeneration && worker === current) {
          lifecycleState = "ready";
          scheduleEviction();
        }
      }
    },
    interrupt() {
      void closeWorker();
    },
    dispose() {
      return closeWorker();
    },
    state() {
      return lifecycleState;
    },
  };
}
