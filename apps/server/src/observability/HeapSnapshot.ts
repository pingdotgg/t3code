// @effect-diagnostics nodeBuiltinImport:off - v8.writeHeapSnapshot has no Effect equivalent.
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

/**
 * Writes a V8 heap snapshot of the server into its logs dir when the process
 * gets SIGUSR2 (`kill -USR2 <pid>`), so a maintainer can see what a
 * long-running server holds. See "Heap Snapshots" in
 * docs/operations/observability.md.
 *
 * `writeHeapSnapshot` is synchronous on the only JS thread, so two snapshots
 * never overlap: a signal sent during a write waits until it finishes. Windows
 * has no SIGUSR2, so the layer does nothing there.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const { logsDir } = yield* ServerConfig.ServerConfig;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    const writeSnapshot = Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
      const path = NodePath.join(logsDir, `server-${process.pid}-${timestamp}.heapsnapshot`);
      yield* Effect.annotateCurrentSpan({ path });
      yield* Effect.sync(() => NodeV8.writeHeapSnapshot(path));
      yield* Effect.logInfo("Wrote heap snapshot.", { path });
    }).pipe(
      Effect.catchDefect((cause) => Effect.logWarning("Failed to write heap snapshot.", { cause })),
      Effect.withSpan("server.heapSnapshot", { root: true }),
    );

    const onSignal = () => {
      runFork(writeSnapshot);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.on("SIGUSR2", onSignal);
      }),
      () =>
        Effect.sync(() => {
          process.off("SIGUSR2", onSignal);
        }),
    );
  }),
);
