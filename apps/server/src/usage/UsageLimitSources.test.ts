import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it("recognizes Command Code by provider driver or ACP agent, never by instance key", () => {
  const providerInstances = {
    [ProviderInstanceId.make("cc")]: {
      driver: ProviderDriverKind.make("acpRegistry"),
      config: { agentId: "command-code-omarchy" },
    },
  };
  expect(UsageLimitSources.hasConfiguredCommandCodeProvider(providerInstances)).toBe(true);
  expect(
    UsageLimitSources.hasConfiguredCommandCodeProvider({
      [ProviderInstanceId.make("command-code-pretender")]: {
        driver: ProviderDriverKind.make("opencode"),
      },
    }),
  ).toBe(false);
  expect(
    UsageLimitSources.hasConfiguredCommandCodeProvider({
      [ProviderInstanceId.make("direct")]: { driver: ProviderDriverKind.make("command-code") },
    }),
  ).toBe(true);
  expect(
    UsageLimitSources.hasConfiguredCommandCodeProvider({
      [ProviderInstanceId.make("unrelated")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        config: { agentId: "other-agent" },
      },
    }),
  ).toBe(false);
});

it.effect("refreshes usage limits when a Command Code provider instance is added", () =>
  Effect.gen(function* () {
    const baseContext = yield* Layer.build(ServerSettings.layerTest());
    const baseSettings = Context.get(baseContext, ServerSettings.ServerSettingsService);
    const initial = yield* baseSettings.getSettings;
    const current = yield* Ref.make(initial);
    const updates = yield* Queue.unbounded<typeof initial>();
    const firstEventObserved = yield* Deferred.make<void>();
    const refreshedWithProvider = yield* Deferred.make<void>();
    const settings = {
      ...baseSettings,
      getSettings: Ref.get(current).pipe(
        Effect.tap((snapshot) =>
          UsageLimitSources.hasConfiguredCommandCodeProvider(snapshot.providerInstances)
            ? Deferred.succeed(refreshedWithProvider, undefined).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
      streamChanges: Stream.fromQueue(updates).pipe(
        Stream.tap(() => Deferred.succeed(firstEventObserved, undefined).pipe(Effect.ignore)),
      ),
    };

    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
    );
    yield* sources.refresh;
    yield* Queue.offer(updates, initial);
    yield* Deferred.await(firstEventObserved);

    const configured = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [ProviderInstanceId.make("cc")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: "command-code" },
        },
      },
    };
    yield* Ref.set(current, configured);
    yield* Queue.offer(updates, configured);
    yield* Deferred.await(refreshedWithProvider);
  }).pipe(
    Effect.provide([
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
