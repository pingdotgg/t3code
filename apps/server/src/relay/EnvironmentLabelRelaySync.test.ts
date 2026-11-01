import { EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as EnvironmentLabelRelaySync from "./EnvironmentLabelRelaySync.ts";

const settingsWith = (environmentLabel: string, enableProviderUpdateChecks = true) =>
  ({ environmentLabel, enableProviderUpdateChecks }) as ServerSettings;

it.effect("sends the current host name at startup and only changed names thereafter", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const pushed = yield* Queue.unbounded<{ readonly url: string; readonly body: unknown }>();
    const failedAttempts = yield* Queue.unbounded<void>();
    const unlinkedReads = yield* Queue.unbounded<void>();
    let remainingFailures = 0;
    const fetch: typeof globalThis.fetch = Object.assign(
      (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          Queue.offerUnsafe(failedAttempts, undefined);
          return Promise.reject(new Error("Relay unavailable"));
        }
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
        get: (name) =>
          Effect.sync(() => {
            const value = stored.get(name);
            if (name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET && value === undefined) {
              Queue.offerUnsafe(unlinkedReads, undefined);
            }
            return Option.fromNullishOr(value);
          }),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptorForSettings: ({ environmentLabel }) =>
          Effect.succeed({
            environmentId: EnvironmentId.make("environment-1"),
            label: environmentLabel || "Detected Mac",
          } as never),
      }),
      Layer.mock(ServerSettingsService.ServerSettingsService)({
        getEnvironmentLabel: Effect.succeed("Saved Mac"),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      }),
    );
    yield* Layer.build(EnvironmentLabelRelaySync.layer.pipe(Layer.provide(layerDependencies))).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

    yield* PubSub.publish(changes, settingsWith("Saved Mac", false));
    yield* PubSub.publish(changes, settingsWith("Studio Mac"));
    const initial = yield* Queue.take(pushed);
    assert.equal(initial.url, "https://relay.test/v1/environments/environment-1/label");
    assert.deepEqual(initial.body, { label: "Saved Mac" });
    const renamed = yield* Queue.take(pushed);
    assert.equal(renamed.url, "https://relay.test/v1/environments/environment-1/label");
    assert.deepEqual(renamed.body, { label: "Studio Mac" });

    // An unrelated setting does not resend the name; clearing it sends the detected one.
    yield* PubSub.publish(changes, settingsWith("Studio Mac", false));
    yield* PubSub.publish(changes, settingsWith("", false));
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "Detected Mac" });

    const exhaustPush = Effect.fn("RelayLabelTest.exhaustPush")(function* (label: string) {
      remainingFailures = 4;
      yield* PubSub.publish(changes, settingsWith(label));
      yield* Queue.take(failedAttempts);
      for (const delay of ["2 seconds", "4 seconds", "8 seconds"] as const) {
        yield* TestClock.adjust(delay);
        yield* Queue.take(failedAttempts);
      }
    });
    yield* exhaustPush("Retry Mac");
    yield* PubSub.publish(changes, settingsWith("Retry Mac", false));
    yield* PubSub.publish(changes, settingsWith("Retry Mac", true));
    yield* PubSub.publish(changes, settingsWith("After Retry"));
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "Retry Mac" });
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "After Retry" });

    yield* exhaustPush("Unconfirmed name");
    yield* PubSub.publish(changes, settingsWith("After Retry"));
    yield* PubSub.publish(changes, settingsWith("Recovered"));
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "After Retry" });
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "Recovered" });

    stored.delete(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
    yield* PubSub.publish(changes, settingsWith("Unlinked name"));
    yield* Queue.take(unlinkedReads);
    stored.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("relinked-credential"),
    );
    yield* PubSub.publish(changes, settingsWith("Recovered"));
    yield* PubSub.publish(changes, settingsWith("Relinked"));
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "Recovered" });
    assert.deepEqual((yield* Queue.take(pushed)).body, { label: "Relinked" });
  }).pipe(Effect.scoped),
);
