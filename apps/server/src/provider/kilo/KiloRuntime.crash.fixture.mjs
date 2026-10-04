import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Runtime from "./KiloRuntime.ts";

// Report the owned PID immediately for emergency cleanup; readiness is separate.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let pid;
      const runtime = yield* Runtime.make({
        instanceId: "crash-fixture",
        binaryPath: process.argv[2],
        profileDirectory: process.argv[3],
        ...(process.argv[4] ? { processStateDirectory: process.argv[4] } : {}),
        environment: {
          PATH: process.env.PATH,
          HOME: process.argv[3],
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_DEFAULT_PLUGINS: "1",
          KILO_DISABLE_EXTERNAL_SKILLS: "1",
        },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
          ...spawner,
          spawn: (...args) =>
            spawner.spawn(...args).pipe(
              Effect.tap((child) =>
                Effect.sync(() => {
                  pid = Number(child.pid);
                  process.send({ type: "spawned", pid });
                }),
              ),
            ),
        }),
      );
      const connection = yield* runtime.open(process.argv[3]);
      const session = yield* connection.client.create([]);
      process.send({ type: "ready", pid, session });
      yield* Effect.never;
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
