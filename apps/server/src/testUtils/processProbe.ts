// @effect-diagnostics nodeBuiltinImport:off - a socket observes fixture processes after their parent exits.
import * as NodeNet from "node:net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

export const makeProcessProbe = Effect.gen(function* () {
  const started = yield* Deferred.make<number>();
  const exited = yield* Deferred.make<void>();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    let output = "";
    socket.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        const pid = Number(output.trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          Deferred.doneUnsafe(started, Effect.succeed(pid));
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      Deferred.doneUnsafe(exited, Effect.void);
    });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die("Missing process probe port");
  }
  return {
    port: address.port,
    started: Deferred.await(started).pipe(
      Effect.timeout("4 seconds"),
      TestClock.withLive,
      Effect.tap((pid) =>
        Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(exited)) return;
            // Only a PID reported by this fixture is eligible for failure cleanup.
            yield* Effect.sync(() => {
              try {
                process.kill(pid, "SIGKILL");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
            });
          }),
        ),
      ),
    ),
    exited: Deferred.await(exited).pipe(Effect.timeout("4 seconds"), TestClock.withLive),
  };
});

export const processProbeSource = (port: number) => `
  const { createConnection } = await import("node:net");
  const probe = createConnection(${port}, "127.0.0.1", () => {
    probe.write(process.pid + "\\n");
  });
`;
