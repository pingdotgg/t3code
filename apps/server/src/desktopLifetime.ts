// @effect-diagnostics nodeBuiltinImport:off - a net.Socket reads the inherited pipe without holding a threadpool thread.
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";

// Runs the shutdown a SIGTERM from the desktop would. Emitting the event rather
// than signalling keeps it graceful on Windows, where a real SIGTERM ends the
// process without running any handler.
const shutDown = Effect.sync(() => {
  if (!process.emit("SIGTERM", "SIGTERM")) {
    process.kill(process.pid, "SIGTERM");
  }
});

/**
 * Runs `onDesktopExit` once the desktop app that spawned this server has
 * exited. The desktop holds the only write end of `fd` and never writes to or
 * closes it, so EOF means its process is gone, including crashes and SIGKILL
 * that skip its own backend shutdown. A descriptor that cannot be watched is
 * logged and ignored.
 */
export const watch = (fd: number, onDesktopExit: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.try(() => new NodeNet.Socket({ fd, readable: true, writable: false })),
    (socket) => Effect.sync(() => socket.destroy()),
  ).pipe(
    Effect.flatMap((socket) =>
      Effect.callback<void, Error>((resume) => {
        const onEnd = () => resume(Effect.void);
        socket.once("end", onEnd);
        // Stays attached for the socket's life, so a late error is never unhandled.
        socket.on("error", (error) => resume(Effect.fail(error)));
        socket.resume();
        return Effect.sync(() => {
          socket.off("end", onEnd);
        });
      }),
    ),
    Effect.andThen(Effect.logInfo("The desktop app exited; shutting down.", { fd })),
    Effect.andThen(onDesktopExit),
    Effect.catch((cause) =>
      Effect.logWarning("Cannot watch the desktop app's lifetime.", { fd, cause }),
    ),
    Effect.forkScoped,
  );

/** Shuts the server down when the desktop app that spawned it exits. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { desktopLifetimeFd } = yield* ServerConfig.ServerConfig;
    if (desktopLifetimeFd === undefined) return;
    yield* watch(desktopLifetimeFd, shutDown);
  }),
);
