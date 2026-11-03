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
const hubAccounts = [
  { id: "visible.json", auth_index: "a", provider: "codex", email: "visible@example.com" },
  { id: "hidden.json", auth_index: "b", provider: "codex", email: "hidden@example.com" },
];
const hubConfig = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;

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

it.effect("partitions hidden hub accounts and omits the field when nothing is hidden", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    const filtered = snapshots.find((snapshot) => snapshot.id === "filtered-hub");
    const unfiltered = snapshots.find((snapshot) => snapshot.id === "unfiltered-hub");
    if (!filtered || !unfiltered) throw new Error("expected both hub snapshots");

    expect(filtered.accounts.map((account) => account.id)).toEqual(["visible.json"]);
    expect(filtered.hidden).toEqual([
      { id: "hidden.json", driver: "codex", email: "hidden@example.com" },
    ]);
    expect(unfiltered.accounts.map((account) => account.id)).toEqual([
      "visible.json",
      "hidden.json",
    ]);
    expect("hidden" in unfiltered).toBe(false);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("filtered-hub")]: {
            ...hubConfig,
            hiddenAccounts: ["hidden.json"],
          },
          [UsageLimitSourceId.make("unfiltered-hub")]: {
            ...hubConfig,
            hiddenAccounts: [],
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
            expect(request.headers.authorization).toBe("Bearer management-secret");
            if (new URL(request.url).pathname.endsWith("/v0/management/auth-files")) {
              return HttpClientResponse.fromWeb(request, Response.json({ files: hubAccounts }));
            }
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ status_code: 500, body: "" }),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
