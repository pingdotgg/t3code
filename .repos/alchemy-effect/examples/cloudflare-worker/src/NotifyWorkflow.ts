import * as Cloudflare from "alchemy/Cloudflare";
import { Config } from "effect";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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

    const kv = yield* Cloudflare.KV.ReadWriteNamespace(KV);

    return Effect.fn(function* (input: { roomId: string; message: string }) {
      const { roomId, message } = input;

      const stored = yield* Cloudflare.Workflows.task(
        "kv-roundtrip",
        Effect.gen(function* () {
          const key = `workflow:smoke:${roomId}`;
          yield* kv.put(key, message);
          // KV is eventually consistent: a read immediately after a write can
          // briefly miss or return stale data. Re-read until it reflects the
          // write (bounded, so a genuine failure still surfaces below).
          const got = yield* kv.get(key).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (value) => value === message,
              times: 10,
            }),
          );
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

      const processed = yield* Cloudflare.Workflows.task(
        "process",
        Effect.succeed({
          text: `Processed: ${stored}`,
          secret: secretValue,
          ts: Date.now(),
        }),
      );

      const room = rooms.getByName(roomId);
      yield* Cloudflare.Workflows.task(
        "broadcast",
        room.broadcast(`[workflow] ${processed.text} secret=${secretValue}`),
      );

      yield* Cloudflare.Workflows.sleep("cooldown", "2 seconds");

      yield* Cloudflare.Workflows.task(
        "finalize",
        room.broadcast(`[workflow] complete for ${roomId}`),
      );

      return processed;
    });
  }),
) {}
