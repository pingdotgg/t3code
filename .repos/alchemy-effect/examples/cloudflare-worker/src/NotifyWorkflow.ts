import * as Cloudflare from "alchemy/Cloudflare";
import { Config } from "effect";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { KV } from "./KV.ts";
import Room from "./Room.ts";

/**
 * Hard-coded value the integ test asserts on to prove the secret was
 * bound at plantime and read at runtime through the `Redacted` accessor.
 */
export const WORKFLOW_SECRET_VALUE = Redacted.make("wf-secret-abc123");

export default class NotifyWorkflow extends Cloudflare.Workflow<NotifyWorkflow>()(
  "Notifier",
  Effect.gen(function* () {
    const rooms = yield* Room;

    const secret = yield* Config.redacted("WORKFLOW_SECRET").pipe(
      Config.withDefault(WORKFLOW_SECRET_VALUE),
    );

    // Regression guard for https://github.com/alchemy-run/alchemy-effect/pull/71
    //
    // The kv binding internally yields `Cloudflare.WorkerEnvironment` —
    // before that PR, accessing `WorkerEnvironment` inside a workflow body
    // crashed because `provideService(WorkerEnvironment, env)` was applied
    // to the outer `Effect.succeed(body)` wrapper (a no-op) instead of
    // `body` itself in `Workflow.ts`. Exercising `kv.put` / `kv.get` from
    // inside a `task` keeps the integ test catching any future regression.
    const kv = yield* Cloudflare.KVNamespace.bind(KV);

    return Effect.fn(function* (input: { roomId: string; message: string }) {
      const { roomId, message } = input;

      const stored = yield* Cloudflare.task(
        "kv-roundtrip",
        Effect.gen(function* () {
          const key = `workflow:smoke:${roomId}`;
          yield* kv.put(key, message);
          const got = yield* kv.get(key);
          if (got !== message) {
            return yield* Effect.die(
              new Error(
                `KV roundtrip mismatch: expected "${message}", got "${got ?? "null"}"`,
              ),
            );
          }
          return got;
        }).pipe(Effect.orDie),
      );

      // Resolve the bound secret inside the workflow body. The accessor
      // returns `Redacted<string>`; unwrap only where the value needs to
      // leave the workflow (here, in the broadcast + the returned output
      // so the integ test can assert end-to-end propagation).
      const secretValue = Redacted.value(secret);

      const processed = yield* Cloudflare.task(
        "process",
        Effect.succeed({
          text: `Processed: ${stored}`,
          secret: secretValue,
          ts: Date.now(),
        }),
      );

      const room = rooms.getByName(roomId);
      yield* Cloudflare.task(
        "broadcast",
        room.broadcast(`[workflow] ${processed.text} secret=${secretValue}`),
      );

      yield* Cloudflare.sleep("cooldown", "2 seconds");

      yield* Cloudflare.task(
        "finalize",
        room.broadcast(`[workflow] complete for ${roomId}`),
      );

      return processed;
    });
  }),
) {}
