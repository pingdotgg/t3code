import {
  type EnvironmentCloudPreferencesRequest,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
import {
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  readRelayConnection,
} from "./config.ts";

const encode = (value: boolean) => new TextEncoder().encode(String(value));

/** A failed rollback leaves a setting changed; it is logged, not hidden. */
const rollbackFailed = (cause: unknown) =>
  Effect.logWarning("Could not roll back a T3 Connect preference", { cause });

const internalError = (message: string) => (cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
  );

export class CloudPreferences extends Context.Service<
  CloudPreferences,
  {
    /**
     * Saves this environment's T3 Connect preferences, all or nothing. The
     * activity setting is saved first. Holding webhooks while offline is decided
     * by the relay, so the relay is told before the local copy is saved. If
     * either step fails, the activity setting is put back, and so is the relay
     * when only the local save failed.
     */
    readonly update: (
      input: EnvironmentCloudPreferencesRequest,
    ) => Effect.Effect<void, EnvironmentHttpBadRequestError | EnvironmentHttpInternalServerError>;
  }
>()("t3/cloud/CloudPreferences") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const awarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const withSecrets = Effect.provideService(ServerSecretStore.ServerSecretStore, secrets);

  const pushHoldWebhooksWhileOffline = Effect.fn("CloudPreferences.pushHoldWebhooksWhileOffline")(
    function* (holdWebhooksWhileOffline: boolean) {
      const connection = yield* readRelayConnection.pipe(withSecrets);
      if (connection === null) {
        return yield* new EnvironmentHttpBadRequestError({
          message: "Link this environment to T3 Connect first.",
        });
      }
      const environmentId = yield* environment.getEnvironmentId;
      const client = yield* makeRelayEnvironmentClient(connection);
      yield* client.server
        .updateLinkPreferences({
          params: { environmentId },
          payload: { holdWebhooksWhileOffline },
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(internalError("Could not update T3 Connect webhook settings.")),
        );
    },
  );

  const save = (name: string, value: boolean) =>
    secrets
      .set(name, encode(value))
      .pipe(Effect.catch(internalError("Could not persist environment cloud preferences.")));

  // One update at a time, so two requests can't each leave one setting behind.
  const updateLock = yield* Semaphore.make(1);

  const update: CloudPreferences["Service"]["update"] = Effect.fn("CloudPreferences.update")(
    function* (input) {
      // All or nothing: the activity setting is saved first, before the relay
      // is told anything, and put back if the hold change then fails. Both
      // current values are read up front; a failed read stops here, before
      // anything changes, because a guessed value would be the rollback target.
      const readCurrent = (name: string) =>
        secrets
          .get(name)
          .pipe(Effect.catch(internalError("Could not read environment cloud preferences.")));
      const previousActivity = yield* readCurrent(PUBLISH_AGENT_ACTIVITY_SECRET);
      const previousHold = yield* readCurrent(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET);
      yield* save(PUBLISH_AGENT_ACTIVITY_SECRET, input.publishAgentActivity);
      if (input.holdWebhooksWhileOffline !== undefined) {
        const next = input.holdWebhooksWhileOffline;
        const previous = Option.match(previousHold, {
          onNone: () => false,
          onSome: (bytes) => new TextDecoder().decode(bytes) === "true",
        });
        yield* pushHoldWebhooksWhileOffline(next).pipe(
          Effect.andThen(
            save(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, next).pipe(
              Effect.tapError(() =>
                previous === next
                  ? Effect.void
                  : pushHoldWebhooksWhileOffline(previous).pipe(Effect.catch(rollbackFailed)),
              ),
            ),
          ),
          Effect.tapError(() =>
            Option.match(previousActivity, {
              onNone: () => secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
              onSome: (bytes) => secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, bytes),
            }).pipe(Effect.catch(rollbackFailed)),
          ),
        );
      }
      yield* awarenessRelay.requestCatchUp();
    },
    // A client that disconnects mid-update must not stop it between a save and
    // its rollback, so an update always finishes or undoes itself.
    Effect.uninterruptible,
    updateLock.withPermits(1),
  );

  return CloudPreferences.of({ update });
});

export const layer = Layer.effect(CloudPreferences, make);
