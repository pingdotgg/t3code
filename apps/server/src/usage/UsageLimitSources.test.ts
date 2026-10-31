import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

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
