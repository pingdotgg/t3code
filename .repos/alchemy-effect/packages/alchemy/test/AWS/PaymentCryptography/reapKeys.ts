import * as paymentcryptography from "@distilled.cloud/aws/payment-cryptography";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Out-of-band reaper for leaked Payment Cryptography keys.
 *
 * Payment Cryptography keys cannot be hard-deleted: `DeleteKey` only
 * *schedules* deletion after a mandatory waiting window (minimum 3 days),
 * during which the key stays visible in `ListKeys` as `DELETE_PENDING`.
 * The scratch stacks these suites deploy through keep state in memory, so a
 * crashed run (vitest timeout kill, OOM) leaves its keys ACTIVE with no
 * state pointing at them — no later run can reclaim them through the engine.
 *
 * This sweep lists every key, skips those already pending/complete deletion,
 * and idempotently schedules deletion (minimum window) for any key branded
 * with the internal alchemy tags at stage `test` — optionally narrowed to
 * specific stack names so a gated suite only ever reaps its own keys.
 *
 * `DELETE_PENDING` is the best achievable end state; the service purges the
 * key itself when the window elapses. Errors are defects (`orDie`) so this
 * is a valid `Effect.ensuring` finalizer.
 */
export const reapLeakedKeys = (stackNames?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const keys = yield* paymentcryptography.listKeys.items({}).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );
    for (const key of keys) {
      if (
        key.KeyState === "DELETE_PENDING" ||
        key.KeyState === "DELETE_COMPLETE"
      ) {
        continue; // already handled — the service purges it after the window
      }
      const tags: Record<string, string> =
        yield* paymentcryptography.listTagsForResource
          .items({ ResourceArn: key.KeyArn })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Object.fromEntries(
                Array.from(chunk).map((t) => [t.Key, t.Value ?? ""]),
              ),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({}),
            ),
          );
      const stack = tags["alchemy::stack"];
      const owned =
        tags["alchemy::stage"] === "test" &&
        stack !== undefined &&
        (stackNames === undefined || stackNames.includes(stack));
      if (!owned) continue;
      yield* paymentcryptography
        .deleteKey({ KeyIdentifier: key.KeyArn, DeleteKeyInDays: 3 })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          // Raced into DELETE_PENDING between observe and delete — done.
          Effect.catchTag("ConflictException", () => Effect.void),
        );
    }
  }).pipe(Effect.orDie);
