import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
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

it.effect("reads routed sessions only from hubs that opted in", () =>
  Effect.gen(function* () {
    const queueReads: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/usage-queue")) {
          queueReads.push(url.host);
          return HttpClientResponse.fromWeb(
            request,
            Response.json([{ session_id: "thread-session", auth_index: "a" }]),
          );
        }
        if (url.pathname.endsWith("/auth-files")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              files: [{ id: "claude-a.json", auth_index: "a", provider: "claude" }],
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ status_code: 200, body: JSON.stringify({}) }),
        );
      }),
    );
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* sources.refresh;
    yield* TestClock.adjust("30 seconds");

    const snapshots = yield* sources.current;
    expect(queueReads).toEqual(["routed.test"]);
    expect(
      snapshots.map((source) => [source.id, source.accounts.map((account) => account.sessionIds)]),
    ).toEqual([
      ["routed", [["thread-session"]]],
      ["observed", [undefined]],
    ]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("routed")]: {
            kind: "cliproxy",
            url: "https://routed.test",
            managementKey: "key",
            enabled: true,
            threadAccounts: true,
          },
          [UsageLimitSourceId.make("observed")]: {
            kind: "cliproxy",
            url: "https://observed.test",
            managementKey: "key",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(true),
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
