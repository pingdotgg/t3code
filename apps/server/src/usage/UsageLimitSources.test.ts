import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ManagedProviderProxy from "../providerProxy/ManagedProviderProxy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

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
      ManagedProviderProxy.ManagedProviderProxy.layerTest(),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it("reports the routing proxy's accounts unless a hub already points at it or owns its id", () => {
  const hub = {
    kind: "cliproxy" as const,
    url: "http://proxy:8317/",
    managementKey: "hub-key",
    enabled: true,
  };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerProxy: { url: "http://proxy:8317/v1", apiKey: "sk", managementKey: "mgmt" },
  };

  expect(UsageLimitSources.effectiveUsageLimitSources(settings)).toEqual({
    [UsageLimitSources.PROVIDER_PROXY_SOURCE_ID]: {
      kind: "cliproxy",
      label: "Proxy",
      url: "http://proxy:8317",
      managementKey: "mgmt",
      enabled: true,
    },
  });
  for (const unusable of [
    { ...hub, managementKey: "" },
    { ...hub, enabled: false },
  ]) {
    expect(
      UsageLimitSources.effectiveUsageLimitSources({
        ...settings,
        usageLimitSources: { [UsageLimitSourceId.make("hub")]: unusable },
      })[UsageLimitSources.PROVIDER_PROXY_SOURCE_ID]?.managementKey,
    ).toBe("mgmt");
  }
  for (const listed of [
    { [UsageLimitSourceId.make("hub")]: hub },
    {
      [UsageLimitSources.PROVIDER_PROXY_SOURCE_ID]: {
        ...hub,
        url: "https://other.example.test",
      },
    },
  ]) {
    expect(
      UsageLimitSources.effectiveUsageLimitSources({ ...settings, usageLimitSources: listed }),
    ).toBe(listed);
  }

  // A managed proxy reports through its own loopback management key; turning the host off hides it.
  const managed = { url: "http://127.0.0.1:41234", apiKey: "sk", managementKey: "managed-mgmt" };
  const managedSettings = {
    ...settings,
    providerProxy: { ...settings.providerProxy, host: "managed" as const },
  };
  expect(
    UsageLimitSources.effectiveUsageLimitSources(managedSettings, managed)[
      UsageLimitSources.PROVIDER_PROXY_SOURCE_ID
    ],
  ).toMatchObject({ url: "http://127.0.0.1:41234", managementKey: "managed-mgmt" });
  expect(UsageLimitSources.effectiveUsageLimitSources(managedSettings)).toEqual({});
  expect(
    UsageLimitSources.effectiveUsageLimitSources(
      { ...settings, providerProxy: { ...settings.providerProxy, host: "off" } },
      managed,
    ),
  ).toEqual({});
});

it.effect("refreshes once at startup and again when managed proxy status changes", () =>
  Effect.gen(function* () {
    const refreshes = yield* Ref.make(0);
    const initialStatusRead = yield* Deferred.make<void>();
    const changedStatusRead = yield* Deferred.make<void>();
    const statuses = yield* Queue.unbounded<{ readonly status: "running" }>();
    const baseline = yield* ManagedProviderProxy.ManagedProviderProxy.pipe(
      Effect.provide(ManagedProviderProxy.ManagedProviderProxy.layerTest()),
    );
    const managed = Layer.succeed(ManagedProviderProxy.ManagedProviderProxy, {
      ...baseline,
      statusChanges: Stream.concat(
        Stream.make({ status: "stopped" } as const),
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(initialStatusRead, undefined)).pipe(Stream.drain),
          Stream.fromQueue(statuses),
        ),
      ),
    });
    const http = HttpClient.make((request) =>
      Ref.updateAndGet(refreshes, (count) => count + 1).pipe(
        Effect.tap((count) =>
          count === 3 ? Deferred.succeed(changedStatusRead, undefined) : Effect.void,
        ),
        Effect.map(() => HttpClientResponse.fromWeb(request, new Response("{}", { status: 401 }))),
      ),
    );
    yield* Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* Deferred.await(initialStatusRead);
      yield* sources.refresh;
      expect(yield* Ref.get(refreshes)).toBe(2);
      yield* Queue.offer(statuses, { status: "running" });
      yield* Deferred.await(changedStatusRead);
      yield* sources.refresh;
      expect(yield* Ref.get(refreshes)).toBe(4);
    }).pipe(Effect.provide([managed, Layer.succeed(HttpClient.HttpClient, http)]));
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test",
            managementKey: "mgmt",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
