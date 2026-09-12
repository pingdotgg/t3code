// @effect-diagnostics nodeBuiltinImport:off
// Node IPC belongs at this boundary; the index and its callers remain Effects.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { HostProcessEnvironment, HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { SearchResponse, type SearchRequest } from "./workspaceSearchProtocol.ts";

const decodeSearchResponse = Schema.decodeUnknownEffect(SearchResponse);

export const WorkspaceSearchWorkerPath = Context.Reference<URL>("t3/workspace/SearchWorkerPath", {
  defaultValue: () =>
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../workspaceSearchWorker.ts"
        : "./workspaceSearchWorker.mjs",
      import.meta.url,
    ),
});

export class WorkspaceSearchProcessFailed extends Schema.TaggedError<WorkspaceSearchProcessFailed>()(
  "WorkspaceSearchProcessFailed",
  { cause: Schema.Defect() },
) {}

export const startSearchProcess = Effect.fn("WorkspaceSearchProcess.start")(function* () {
  const workerPath = yield* WorkspaceSearchWorkerPath;
  const environment = yield* HostProcessEnvironment;
  const executable = yield* HostProcessExecutablePath;
  const child = yield* Effect.try(() =>
    NodeChildProcess.spawn(executable, [NodeURL.fileURLToPath(workerPath)], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    }),
  );
  let failure: Error | undefined;
  let exited = false;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192);
  });
  const exitFailure = () =>
    new WorkspaceSearchProcessFailed({
      cause:
        failure ??
        new Error(`Workspace search process exited${stderr ? `: ${stderr.trim()}` : "."}`),
    });
  child.on("error", (error) => {
    failure = error;
  });
  child.once("exit", () => {
    exited = true;
  });

  // These indexes are disposable and mmap persistence is disabled. Do not ask
  // the native destructor to run: it can wait on the same lock as search.
  const stop = Effect.callback<void>((resume) => {
    if (exited || child.pid === undefined) {
      resume(Effect.void);
      return;
    }
    const onExit = () => resume(Effect.void);
    child.once("exit", onExit);
    child.kill("SIGKILL");
    return Effect.sync(() => child.removeListener("exit", onExit));
  }).pipe(
    // SIGKILL normally reaps immediately. A process stuck in kernel I/O must
    // not keep server shutdown waiting indefinitely either.
    Effect.timeout("2 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.sync(() => {
        child.unref();
        child.channel?.unref();
        child.stderr?.destroy();
      }),
    ),
  );

  const request = Effect.fn("WorkspaceSearchProcess.request")(function* (input: SearchRequest) {
    const response = yield* Effect.callback<unknown, WorkspaceSearchProcessFailed>((resume) => {
      if (failure || exited || !child.connected) {
        resume(Effect.fail(exitFailure()));
        return;
      }
      const onMessage = (message: unknown) => {
        cleanup();
        resume(Effect.succeed(message));
      };
      const onError = (error: Error) => {
        cleanup();
        resume(Effect.fail(new WorkspaceSearchProcessFailed({ cause: error })));
      };
      const onExit = () => {
        cleanup();
        resume(Effect.fail(exitFailure()));
      };
      const cleanup = () => {
        child.removeListener("message", onMessage);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
      };
      child.once("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      child.send(input, (error) => {
        if (error) onError(error);
      });
      return Effect.sync(cleanup);
    }).pipe(Effect.timeout("20 seconds"));
    const exit = yield* decodeSearchResponse(response);
    return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value);
  });
  return { request, stop };
});
export type SearchProcess = Effect.Success<ReturnType<typeof startSearchProcess>>;
