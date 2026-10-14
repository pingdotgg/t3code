import { EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as EnvironmentLabelRelaySync from "./EnvironmentLabelRelaySync.ts";

const settingsWith = (environmentLabel: string, enableProviderUpdateChecks = true) =>
  ({ environmentLabel, enableProviderUpdateChecks }) as ServerSettings;

it.effect("sends the effective host name to T3 Connect only when it changes", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const pushed = yield* Queue.unbounded<{ readonly url: string; readonly body: unknown }>();
    const fetch: typeof globalThis.fetch = Object.assign(
      (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        Queue.offerUnsafe(pushed, {
          url: String(input instanceof Request ? input.url : input),
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(Response.json({ ok: true }));
      },
      { preconnect: () => {} },
    );
    const stored = new Map([
      [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential")],
    ]);
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptorForSettings: ({ environmentLabel }) =>
          Effect.succeed({
            environmentId: EnvironmentId.make("environment-1"),
            label: environmentLabel || "Detected Mac",
          } as never),
      }),
      Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Effect.succeed(settingsWith("")),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      }),
    );
    yield* Layer.build(EnvironmentLabelRelaySync.layer.pipe(Layer.provide(layerDependencies))).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

    yield* PubSub.publish(changes, settingsWith("Studio Mac"));
    const renamed = yield* Queue.take(pushed);
    assert.equal(renamed.url, "https://relay.test/v1/environments/environment-1/label");
    assert.deepEqual(renamed.body, { label: "Studio Mac" });

    // An unrelated setting does not resend the name; clearing it sends the detected one.
    yield* PubSub.publish(changes, settingsWith("Studio Mac", false));
    yield* PubSub.publish(changes, settingsWith("", false));
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "Detected Mac" });
  }).pipe(Effect.scoped),
);
