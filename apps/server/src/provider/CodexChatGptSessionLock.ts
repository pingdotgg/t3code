// @effect-diagnostics nodeBuiltinImport:off - Credential leases coordinate Node server processes.
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** Keep rotating tokens and their active profile atomic across servers sharing a secret store. */
export const withChatGptSessionLock = <A, E, R>(
  directory: string | undefined,
  key: string,
  instanceId: ProviderInstanceId,
  task: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProviderSetupError, R> => {
  // In-memory stores have no shared filesystem; the auth controller still serializes its callers.
  if (!directory) return task;
  const failure = () =>
    new ProviderSetupError({
      instanceId,
      operation: "credential-lock",
      detail: "Could not lock the ChatGPT connection for an update. Try again.",
    });
  return Effect.scoped(
    Effect.gen(function* () {
      const compromised = yield* Deferred.make<never, ProviderSetupError>();
      const services = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(NodePath.join(directory, `${key}.bin`), {
              realpath: false,
              stale: 120_000,
              update: 10_000,
              retries: { retries: 80, factor: 1, minTimeout: 500, maxTimeout: 500 },
              onCompromised: () =>
                Effect.runSyncWith(services)(Deferred.fail(compromised, failure())),
            }),
          catch: failure,
        }),
        (release) => Effect.promise(() => release()).pipe(Effect.ignore),
      );
      return yield* Effect.raceFirst(task, Deferred.await(compromised));
    }),
  );
};
