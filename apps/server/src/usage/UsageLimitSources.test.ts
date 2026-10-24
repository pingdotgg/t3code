import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
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
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("publishes live credit balances without inventing subscription windows", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [snapshot] = yield* sources.current;
    expect(snapshot?.kind).toBe("credits");
    expect(snapshot?.accounts).toEqual([]);
    expect(snapshot?.balances?.[0]?.available).toBe(12.34);
    expect(snapshot?.balances?.[0]?.partial).toBe(true);
    expect(snapshot?.balances?.[0]?.accounts[0]?.available).toBeNull();
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: [snapshot!] },
      }),
    ).not.toThrow();
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("api-credits")]: {
            kind: "credits",
            url: "http://credits.test/credits",
            managementKey: "local-secret",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.method).toBe("GET");
            expect(request.url).toBe("http://credits.test/credits");
            expect(request.headers.authorization).toBe("Bearer local-secret");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                balances: [
                  {
                    id: "openrouter",
                    label: "OpenRouter",
                    currency: "USD",
                    available: 12.34,
                    checkedAt: "2026-10-24T11:00:00Z",
                    partial: true,
                    accounts: [{ label: "Account 1", available: null, status: "unknown" }],
                  },
                ],
              }),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("keeps a failed credit request unknown and hides remote error bodies", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [snapshot] = yield* sources.current;
    expect(snapshot?.balances).toBeUndefined();
    expect(snapshot?.error).toBe("Could not read credit balances. Balances are unknown.");
    expect(JSON.stringify(snapshot)).not.toContain("remote-secret");
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("api-credits")]: {
            kind: "credits",
            url: "http://credits.test/credits",
            managementKey: "local-secret",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("remote-secret", { status: 503 })),
          ),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
