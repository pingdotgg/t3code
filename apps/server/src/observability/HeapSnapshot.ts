// @effect-diagnostics nodeBuiltinImport:off - v8.writeHeapSnapshot has no Effect equivalent.
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

/**
 * Writes one V8 heap snapshot into `logsDir` and logs its path. A failed write
 * logs a warning and removes any partial file, because that file can hold
 * secrets and the failure is often a full disk.
 */
export const writeHeapSnapshot = Effect.fn("server.heapSnapshot", { root: true })(
  function* (logsDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const path = NodePath.join(logsDir, `server-${process.pid}-${timestamp}.heapsnapshot`);
    yield* Effect.annotateCurrentSpan({ path });
    yield* Effect.try(() => NodeV8.writeHeapSnapshot(path)).pipe(
      Effect.tapError(() => fs.remove(path, { force: true }).pipe(Effect.ignore)),
    );
    yield* Effect.logInfo("Wrote heap snapshot.", { path });
  },
  Effect.catch((cause) => Effect.logWarning("Failed to write heap snapshot.", { cause })),
);

/**
 * Writes a heap snapshot when the process gets SIGUSR2 (`kill -USR2 <pid>`),
 * so a maintainer can see what a long-running server holds. See "Heap
 * Snapshots" in docs/operations/observability.md.
 *
 * The write blocks the event loop, so two snapshots never overlap: a signal
 * sent during a write waits until it finishes. Windows has no SIGUSR2, so the
 * layer does nothing there.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const { logsDir } = yield* ServerConfig.ServerConfig;
    const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem>());
    const onSignal = () => void runFork(writeHeapSnapshot(logsDir));
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("SIGUSR2", onSignal)),
      () => Effect.sync(() => process.off("SIGUSR2", onSignal)),
    );
  }),
);
