import {
  type EnvironmentCloudPreferencesRequest,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
import {
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  readHoldWebhooksWhileOffline,
  readRelayConnection,
} from "./config.ts";

const encode = (value: boolean) => new TextEncoder().encode(String(value));

const internalError = (message: string) => (cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
  );

export class CloudPreferences extends Context.Service<
  CloudPreferences,
  {
    /**
     * Saves this environment's T3 Connect preferences. Holding webhooks while
     * offline is decided by the relay, so it is told first and put back if the
     * local save fails.
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

  const pushHoldWebhooksWhileOffline = Effect.fn("CloudPreferences.pushHoldWebhooksWhileOffline")(
    function* (holdWebhooksWhileOffline: boolean) {
      const connection = yield* readRelayConnection(secrets);
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

  const update: CloudPreferences["Service"]["update"] = Effect.fn("CloudPreferences.update")(
    function* (input) {
      if (input.holdWebhooksWhileOffline !== undefined) {
        const next = input.holdWebhooksWhileOffline;
        const previous = yield* readHoldWebhooksWhileOffline(secrets);
        yield* pushHoldWebhooksWhileOffline(next);
        yield* save(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, next).pipe(
          Effect.tapError(() =>
            previous === next
              ? Effect.void
              : pushHoldWebhooksWhileOffline(previous).pipe(Effect.ignore),
          ),
        );
      }
      yield* save(PUBLISH_AGENT_ACTIVITY_SECRET, input.publishAgentActivity);
      yield* awarenessRelay.requestCatchUp();
    },
  );

  return CloudPreferences.of({ update });
});

export const layer = Layer.effect(CloudPreferences, make);
