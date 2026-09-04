import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";

export class DiffWorkerError extends Schema.TaggedErrorClass<DiffWorkerError>()("DiffWorkerError", {
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
  themeName: Schema.Literals(["pierre-light", "pierre-dark"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: DiffWorkerError["operation"] = "get-render-options";
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = "set-render-options";
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation, themeName, cause }));
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

// Plain-text views do not queue a highlight task that could retry a blank first render.
function DiffWorkerReady({ children }: { children?: ReactNode }) {
  const workerPool = useWorkerPool();
  const [ready, setReady] = useState(
    () => !workerPool || workerPool.isInitialized() || !workerPool.isWorkingPool(),
  );

  useEffect(() => {
    if (ready || !workerPool) return;

    let mounted = true;
    const finish = () => {
      if (mounted) setReady(true);
    };
    // Failed pools use Pierre's existing main-thread highlighter.
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
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-muted-foreground"
    >
      Loading code...
    </div>
  );
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => {
          try {
            return new DiffsWorker();
          } catch (cause) {
            throw new DiffWorkerError({
              operation: "create-worker",
              themeName: diffThemeName,
              cause,
            });
          }
        },
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: diffThemeName,
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <DiffWorkerThemeSync themeName={diffThemeName} />
      <DiffWorkerReady>{children}</DiffWorkerReady>
    </WorkerPoolContextProvider>
  );
}
