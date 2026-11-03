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

it.effect.each(["matched", "other-origin", "path", "duplicate", "disabled", "refresh-failed"])(
  "resolves only a fresh unambiguous managed pool: %s",
  (scenario) =>
    Effect.gen(function* () {
      const config = {
        kind: "cliproxy" as const,
        url: "http://hub.test",
        managementKey: "management",
        enabled: scenario !== "disabled",
      };
      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          ServerSettings.layerTest({
            usageLimitSources: {
              [UsageLimitSourceId.make("hub")]: config,
              ...(scenario === "duplicate" ? { [UsageLimitSourceId.make("second")]: config } : {}),
            },
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                const path = new URL(request.url).pathname;
                const body = path.endsWith("/config")
                  ? { "api-keys": ["global"] }
                  : path.endsWith("/models")
                    ? { models: [{ id: "claude-opus-5-5" }] }
                    : {
                        files: [
                          {
                            id: "a",
                            auth_index: "a",
                            provider: "claude",
                            disabled: false,
                            cooldowns: [
                              {
                                scope: "model",
                                model_key: "claude-opus-5-5",
                                reason: "quota",
                                retry_at: "2099-01-01T00:00:00Z",
                              },
                            ],
                          },
                        ],
                      };
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json(body, { status: scenario === "refresh-failed" ? 503 : 200 }),
                );
              }),
            ),
          ),
          NodeCrypto.layer,
        ]),
      );
      expect(
        yield* sources.poolResetAt({
          baseUrl:
            scenario === "other-origin"
              ? "http://other.test"
              : scenario === "path"
                ? "http://hub.test/proxy"
                : config.url,
          apiKey: "global",
          model: "claude-opus-5-5",
        }),
      ).toBe(scenario === "matched" ? "2099-01-01T00:00:00.000Z" : null);
    }).pipe(Effect.scoped),
);
