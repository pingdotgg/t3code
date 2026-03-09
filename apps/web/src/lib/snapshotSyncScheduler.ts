type QueueMode = "none" | "debounced" | "immediate";

interface IdleWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface SnapshotSyncScheduler {
  requestDebounced(): void;
  requestImmediate(): Promise<void>;
  dispose(): void;
}

export interface SnapshotSyncSchedulerOptions {
  debounceMs: number;
  run: () => Promise<void>;
}

export function createSnapshotSyncScheduler(
  options: SnapshotSyncSchedulerOptions,
): SnapshotSyncScheduler {
  let disposed = false;
  let syncing = false;
  let queuedMode: QueueMode = "none";
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let idleWaiters: IdleWaiter[] = [];

  const clearScheduledRun = () => {
    if (timer === null) {
      return;
    }
    globalThis.clearTimeout(timer);
    timer = null;
  };

  const resolveIdleWaiters = () => {
    if (syncing || queuedMode !== "none" || timer !== null) {
      return;
    }
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  };

  const rejectIdleWaiters = (error: Error) => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  };

  const runNext = async (): Promise<void> => {
    if (disposed || syncing || queuedMode === "none") {
      resolveIdleWaiters();
      return;
    }

    clearScheduledRun();
    syncing = true;
    queuedMode = "none";

    try {
      await options.run();
    } finally {
      syncing = false;
      scheduleNextRun();
      resolveIdleWaiters();
    }
  };

  const scheduleNextRun = () => {
    if (disposed || syncing || queuedMode === "none") {
      return;
    }
    if (timer !== null) {
      return;
    }

    if (queuedMode === "immediate") {
      void runNext();
      return;
    }

    timer = globalThis.setTimeout(() => {
      timer = null;
      void runNext();
    }, options.debounceMs);
  };

  const queueRun = (mode: Exclude<QueueMode, "none">) => {
    if (disposed) {
      return;
    }

    if (mode === "immediate") {
      if (queuedMode !== "immediate") {
        queuedMode = "immediate";
      }
      clearScheduledRun();
    } else if (queuedMode === "none") {
      queuedMode = "debounced";
    }

    scheduleNextRun();
  };

  return {
    requestDebounced() {
      queueRun("debounced");
    },
    requestImmediate() {
      if (disposed) {
        return Promise.resolve();
      }

      queueRun("immediate");

      return new Promise<void>((resolve, reject) => {
        idleWaiters.push({ resolve, reject });
        resolveIdleWaiters();
      });
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearScheduledRun();
      rejectIdleWaiters(new Error("Snapshot sync scheduler disposed"));
    },
  };
}
