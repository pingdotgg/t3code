import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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

it.effect("reads the selected hub while an unrelated refresh is still waiting", () =>
  Effect.gen(function* () {
    const stalled = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (new URL(request.url).hostname === "slow.test") {
          yield* Deferred.succeed(stalled, undefined);
          yield* Deferred.await(release);
        }
        const body = request.url.endsWith("/auth-files")
          ? { files: [{ id: "account", auth_index: "one", provider: "claude" }] }
          : {
              status_code: 200,
              body: JSON.stringify({
                five_hour: { utilization: 100, resets_at: "2099-01-01T00:00:00.000Z" },
              }),
            };
        return HttpClientResponse.fromWeb(request, Response.json(body));
      }),
    );
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* Deferred.await(stalled);
    const fallback = yield* UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.provide(UsageLimitSources.layerResetFallback),
      Effect.provideService(UsageLimitSources.UsageLimitSources, sources),
    );
    const result = yield* fallback
      .resetAt({
        instanceId: ProviderInstanceId.make("proxy"),
        driver: ProviderDriverKind.make("claudeAgent"),
      })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(result)).toBe("2099-01-01T00:00:00.000Z");
    expect(yield* Deferred.isDone(release)).toBe(false);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        providerInstances: {
          [ProviderInstanceId.make("proxy")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: "https://fast.test", sensitive: false },
            ],
          },
        },
        usageLimitSources: Object.fromEntries(
          ["fast", "slow"].map((id) => [
            id,
            {
              kind: "cliproxy" as const,
              url: `https://${id}.test`,
              managementKey: "key",
              enabled: true,
            },
          ]),
        ),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

describe("hubPoolResetAt", () => {
  const now = Date.parse("2026-10-30T00:00:00.000Z");
  const hours = (count: number) => DateTime.formatIso(DateTime.makeUnsafe(now + count * 3_600_000));
  const window = (
    usedPercent: number,
    resetsAt?: string,
    id = resetsAt ?? `window-${usedPercent}`,
  ): ServerProviderUsageWindow => ({
    id,
    kind: "session",
    label: "5h",
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
  const hub = (
    ...accounts: ReadonlyArray<readonly [string, ReadonlyArray<ServerProviderUsageWindow>]>
  ): UsageLimitSourceSnapshot => ({
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "hub",
    checkedAt: hours(0),
    accounts: accounts.map(([driver, windows], index) => ({
      id: `account-${index}`,
      driver: ProviderDriverKind.make(driver),
      usageLimits: { checkedAt: hours(0), windows },
    })),
  });

  it.each([
    {
      name: "the first spent account to recover, after all its spent windows reset",
      sources: [
        hub(
          ["codex", [window(100, hours(2))]],
          ["codex", [window(100, hours(1)), window(100, hours(3))]],
        ),
        hub(["claudeAgent", [window(100, hours(0.5))]]),
      ],
      expected: hours(2),
    },
    {
      name: "nothing while an account still has quota",
      sources: [hub(["codex", [window(100, hours(2))]], ["codex", [window(40, hours(1))]])],
      expected: null,
    },
    {
      name: "nothing once a spent window's reset has passed",
      sources: [hub(["codex", [window(100, hours(2))]], ["codex", [window(100, hours(-1))]])],
      expected: null,
    },
    {
      name: "a recovery time while skipping accounts without readings or reset times",
      sources: [hub(["codex", []], ["codex", [window(100)]], ["codex", [window(100, hours(4))]])],
      expected: hours(4),
    },
    {
      name: "a recovery time that ignores spent model-scoped allowances",
      driver: "claudeAgent",
      sources: [
        hub([
          "claudeAgent",
          [window(100, hours(2), "five_hour"), window(100, hours(90), "seven_day_fable")],
        ]),
      ],
      expected: hours(2),
    },
    {
      name: "nothing when the hub pools none of the driver's accounts",
      sources: [hub(["claudeAgent", [window(100, hours(1))]])],
      expected: null,
    },
  ])("returns $name", ({ sources, expected, driver = "codex" }) => {
    expect(UsageLimitSources.hubPoolResetAt(sources, ProviderDriverKind.make(driver), now)).toBe(
      expected,
    );
  });
});

describe("instanceHubIds", () => {
  const source = (url: string, enabled = true) => ({
    kind: "cliproxy" as const,
    url,
    managementKey: "key",
    enabled,
  });
  const settings = {
    usageLimitSources: {
      [UsageLimitSourceId.make("fleet")]: source("https://hub.test:8443/"),
      [UsageLimitSourceId.make("local")]: source("http://127.0.0.1:8317"),
      [UsageLimitSourceId.make("off")]: source("https://off.test", false),
      [UsageLimitSourceId.make("plain")]: source("https://plain.test"),
    },
    providerInstances: {
      [ProviderInstanceId.make("claudeProxy")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "https://HUB.test:8443", sensitive: false },
        ],
      },
      [ProviderInstanceId.make("codexProxy")]: {
        driver: ProviderDriverKind.make("codex"),
        config: {
          launchArgs: `-c 'model_providers.p={base_url="http://127.0.0.1:8317/v1"}' https://off.test`,
        },
      },
      [ProviderInstanceId.make("defaultPort")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "https://plain.test:443/v1", sensitive: false },
          { name: "OTHER_URL", value: "http://hub.test:8443", sensitive: false },
        ],
      },
      [ProviderInstanceId.make("otherPort")]: {
        driver: ProviderDriverKind.make("codex"),
        config: { launchArgs: `-c 'model_providers.p={base_url="http://127.0.0.1:83170/v1"}'` },
      },
    },
  };

  it.each([
    ["claudeProxy", ["fleet"]],
    ["codexProxy", ["local"]],
    ["defaultPort", ["plain"]],
    ["otherPort", []],
    ["missing", []],
  ])("matches %s to the enabled hubs its settings name", (instanceId, expected) => {
    expect([
      ...UsageLimitSources.instanceHubIds(settings, ProviderInstanceId.make(instanceId)),
    ]).toEqual(expected);
  });
});
