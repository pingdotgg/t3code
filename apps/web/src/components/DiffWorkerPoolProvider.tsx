import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { useMemo, type ReactNode } from "react";

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const workerPoolSize = useMemo(() => {
    const cores = typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () =>
          new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), { type: "module" }),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        tokenizeMaxLineLength: 1_000,
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

