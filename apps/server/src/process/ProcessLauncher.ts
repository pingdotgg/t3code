import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as NonBlockingSpawner from "./NonBlockingSpawner.ts";

/**
 * Exposes the active Linux process-launcher helper PID so callers such as port discovery can
 * recognize direct children spawned through the helper instead of directly from the server.
 */
export class ProcessLauncher extends Context.Reference<{
  readonly currentPid: Effect.Effect<number | undefined>;
}>("t3/process/ProcessLauncher", {
  defaultValue: () => ({ currentPid: Effect.undefined }),
}) {}

// On Linux, libuv forks the whole server for every spawn and blocks the event loop while the
// kernel copies its page tables, so commands are launched by a small long-lived helper instead.
export const make = Effect.fn("ProcessLauncher.make")(function* (responseTimeout?: Duration.Input) {
  const fallback = Context.make(
    ChildProcessSpawner.ChildProcessSpawner,
    yield* ChildProcessSpawner.ChildProcessSpawner,
  ).pipe(Context.add(ProcessLauncher, { currentPid: Effect.undefined }));
  if ((yield* HostProcess.Platform) !== "linux") return fallback;

  const helper = NodeChildProcessSpawner.layerProxyProcess({
    executable: yield* HostProcess.ExecutablePath,
    // A single executable cannot run `-e`, so it hosts the helper as a hidden subcommand of bin.ts.
    args: (yield* HostProcess.IsExecutable) ? ["__process-launcher"] : undefined,
    env: {
      ...(yield* HostProcess.Environment),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: undefined,
      // `node --watch` children would report their imports over the helper's IPC channel.
      WATCH_REPORT_DEPENDENCIES: undefined,
    },
    responseTimeout,
  });
  // The trampoline keeps a hung cwd or PATH entry from stalling the helper, and with it every command.
  // Fresh: the server has already built this layer around the forking spawner.
  const launched = Layer.fresh(NonBlockingSpawner.layer).pipe(Layer.provideMerge(helper));
  return yield* Layer.build(launched).pipe(
    Effect.map((context) => {
      const proxy = Context.get(context, NodeChildProcessSpawner.ProxyProcess);
      return Context.make(
        ChildProcessSpawner.ChildProcessSpawner,
        Context.get(context, ChildProcessSpawner.ChildProcessSpawner),
      ).pipe(
        Context.add(ProcessLauncher, {
          currentPid: Effect.map(proxy.currentPid, Option.getOrUndefined),
        }),
      );
    }),
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning("The process launcher did not start; commands fork the server.", error),
        fallback,
      ),
    ),
  );
});

/**
 * The server's one spawner: memoized, so every build site shares a single launcher. The provided
 * spawner stays the fallback when the launcher cannot start.
 */
export const layerServer = Layer.effectContext(make()).pipe(
  Layer.provide(NonBlockingSpawner.layer),
);
