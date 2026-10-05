import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CloudPreferences from "./CloudPreferences.ts";
import {
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const encode = (value: string) => new TextEncoder().encode(value);

/** A linked environment whose secret store can refuse writes, and the relay calls it made. */
const withService = <A, E>(
  options: { readonly failHoldWrite?: boolean; readonly failActivityWrite?: boolean },
  body: (input: {
    readonly preferences: CloudPreferences.CloudPreferences["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly relayCalls: Array<boolean>;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential")],
      [HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, encode("false")],
    ]);
    const relayCalls: Array<boolean> = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { holdWebhooksWhileOffline: boolean };
        relayCalls.push(payload.holdWebhooksWhileOffline);
        return Promise.resolve(Response.json(payload));
      },
      { preconnect: () => {} },
    );
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) =>
          (options.failHoldWrite && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET) ||
          (options.failActivityWrite && name === PUBLISH_AGENT_ACTIVITY_SECRET)
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: new Error("read-only"),
                }),
              )
            : Effect.sync(() => void stored.set(name, value)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ requestCatchUp: () => Effect.void }),
    );
    return yield* Effect.gen(function* () {
      const preferences = yield* CloudPreferences.CloudPreferences;
      return yield* body({ preferences, stored, relayCalls });
    }).pipe(
      Effect.provide(CloudPreferences.layer.pipe(Layer.provide(dependencies))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

it.effect("tells the relay before saving the hold setting locally", () =>
  withService({}, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      yield* preferences.update({ publishAgentActivity: true, holdWebhooksWhileOffline: true });
      assert.deepEqual(relayCalls, [true]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  ),
);

it.effect("puts the relay back when the local save fails", () =>
  withService({ failHoldWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.equal(error._tag, "EnvironmentHttpInternalServerError");
      assert.deepEqual(relayCalls, [true, false]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("leaves the relay untouched when the activity setting can't be saved", () =>
  withService({ failActivityWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.equal(error._tag, "EnvironmentHttpInternalServerError");
      assert.deepEqual(relayCalls, []);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);
