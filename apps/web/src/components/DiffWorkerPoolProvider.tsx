import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as Schema from "effect/Schema";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getRenderedAppearance, subscribeRenderedAppearance } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";

export class DiffWorkerError extends Schema.TaggedError<DiffWorkerError>()("DiffWorkerError", {
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
  themeName: Schema.Literals(["pierre-dark", "t3-light"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

const DIFF_WORKER_IDLE_TTL_MS = 30_000;
function resolveDiffWorkerPoolSize() {
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}
let sharedWorkerPool:
  | {
      readonly pool: WorkerPoolManager;
      readonly unsubscribeTheme: () => void;
      failed: boolean;
      readonly listeners: Set<() => void>;
      consumers: number;
      idleTimer: ReturnType<typeof setTimeout> | undefined;
    }
  | undefined;

// A failed worker must release waiting viewers to main-thread highlighting.
function failDiffWorkerPool(entry: NonNullable<typeof sharedWorkerPool>) {
  if (entry.failed || entry.pool.isInitialized()) return;
  entry.failed = true;
  entry.pool.terminate();
  for (const listener of entry.listeners) listener();
}

function applyDiffWorkerTheme(pool: WorkerPoolManager) {
  const themeName = resolveDiffThemeName(getRenderedAppearance());
  let operation: DiffWorkerError["operation"] = "get-render-options";
  void (async () => {
    try {
      const current = pool.getDiffRenderOptions();
      if (current.theme === themeName) return;
      operation = "set-render-options";
      await pool.setRenderOptions({ ...current, theme: themeName });
    } catch (cause) {
      console.error(new DiffWorkerError({ operation, themeName, cause }));
    }
  })();
}

// The pool follows the rendered appearance for as long as it lives, so it never depends on a
// mounted provider to carry a theme change across.
function createDiffWorkerPool(poolSize: number) {
  const themeName = resolveDiffThemeName(getRenderedAppearance());
  const pool = new WorkerPoolManager(
    {
      workerFactory: () => {
        try {
          const worker = new DiffsWorker();
          worker.addEventListener("error", () => failDiffWorkerPool(entry), { once: true });
          return worker;
        } catch (cause) {
          throw new DiffWorkerError({ operation: "create-worker", themeName, cause });
        }
      },
      poolSize,
      totalASTLRUCacheSize: 240,
    },
    {
      theme: themeName,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      tokenizeMaxLineLength: 1_000,
      useTokenTransformer: true,
    },
  );
  const entry: NonNullable<typeof sharedWorkerPool> = {
    pool,
    failed: false,
    listeners: new Set(),
    unsubscribeTheme: subscribeRenderedAppearance(() => applyDiffWorkerTheme(pool)),
    consumers: 0,
    idleTimer: undefined,
  };
  return entry;
}

function acquireDiffWorkerPool(poolSize: number) {
  const entry = (sharedWorkerPool ??= createDiffWorkerPool(poolSize));
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

// Plain-text views do not queue a highlight task that could retry a blank first render.
function DiffWorkerReady({ failed, children }: { failed: boolean; children?: ReactNode }) {
  const workerPool = useWorkerPool();
  const [readyPool, setReadyPool] = useState<WorkerPoolManager>();
  const ready = workerPool
    ? readyPool === workerPool || workerPool.isInitialized() || !workerPool.isWorkingPool()
    : failed || typeof window === "undefined";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initializes the diff worker pool and marks it ready when its async startup settles
  useEffect(() => {
    if (ready || !workerPool) return;

    let mounted = true;
    const finish = () => {
      if (mounted) setReadyPool(workerPool);
    };
    void workerPool.initialize().then(finish, finish);
    return () => {
      mounted = false;
    };
  }, [ready, workerPool]);

  return ready ? (
    children
  ) : (
    <div
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-meta text-muted-foreground"
    >
      Loading code...
    </div>
  );
}

// Module-level so the subscribe identity is stable: a new one would release and reacquire
// the shared pool on every render.
function subscribeSharedWorkerPool(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const entry = acquireDiffWorkerPool(resolveDiffWorkerPoolSize());
  entry.listeners.add(onStoreChange);
  onStoreChange();
  return () => {
    entry.listeners.delete(onStoreChange);
    entry.consumers -= 1;
    if (entry.consumers !== 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      entry.unsubscribeTheme();
      entry.pool.terminate();
      if (sharedWorkerPool === entry) sharedWorkerPool = undefined;
    }, DIFF_WORKER_IDLE_TTL_MS);
  };
}

export function useDiffWorkerPool() {
  return useSyncExternalStore(
    subscribeSharedWorkerPool,
    () => (sharedWorkerPool?.failed ? null : sharedWorkerPool?.pool),
    () => undefined,
  );
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const workerPool = useDiffWorkerPool();

  return (
    <WorkerPoolContext value={workerPool ?? undefined}>
      <DiffWorkerReady failed={workerPool === null}>{children}</DiffWorkerReady>
    </WorkerPoolContext>
  );
}
