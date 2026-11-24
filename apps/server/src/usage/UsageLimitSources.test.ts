import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(snapshots[3]?.endpoint).toBe("https://hub.test:8317/team-a");
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
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
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
            url: "https://hub.test:8317/team-a/management.html",
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
  ),
);

it.effect("publishes validated HTTP quotas as display-only accounts", () => {
  const window = { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 };
  const accounts = [
    { id: "account", label: "External plan", providerInstanceId: "work-codex", windows: [window] },
  ];
  let usedPercent = 35;
  let oversized = false;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      expect(url.href).toBe("https://quota.test/v1");
      expect(request.headers.authorization).toBe("Bearer test-token");
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    version: 1,
                    accounts: [{ ...accounts[0], windows: [{ ...window, usedPercent }] }],
                  }),
                ),
              );
              if (oversized) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
              controller.close();
            },
          }),
        ),
      );
    }),
  );
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [snapshot] = yield* sources.current;
    expect(snapshot).toMatchObject({ kind: "http", accounts: [], quotaAccounts: accounts });
    expect(snapshot?.origin).toBeUndefined();
    usedPercent = 101;
    yield* sources.refresh;
    const [failed] = yield* sources.current;
    expect(failed).toMatchObject({ accounts: [], error: "Could not read the HTTP quota source." });
    expect(failed?.quotaAccounts).toBeUndefined();
    usedPercent = 35;
    oversized = true;
    yield* sources.refresh;
    expect((yield* sources.current)[0]).toMatchObject({
      accounts: [],
      error: "Could not read the HTTP quota source.",
    });
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("quota")]: {
            kind: "http",
            url: "https://quota.test/v1",
            managementKey: "test-token",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(HttpClient.HttpClient, client),
      NodeCrypto.layer,
    ]),
  );
});

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

it.effect("keeps an account's last good reading when the hub's next read of it is refused", () => {
  let refused = true;
  let workspace = "account-a";
  let listsIdentity = true;
  const readAccount = Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    return Effect.gen(function* () {
      yield* sources.refresh;
      const [source] = yield* sources.current;
      return source?.accounts[0]?.usageLimits;
    });
  });
  return Effect.gen(function* () {
    const read = yield* readAccount;
    // Nothing to keep yet: the account stays listed as unreadable.
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    refused = false;
    const good = yield* read;
    expect(good?.windows.map((window) => window.usedPercent)).toEqual([78]);
    expect(good?.unavailable).toBeUndefined();
    refused = true;
    expect(yield* read).toEqual(good);
    // The same auth file now holds another login, whose reading is unknown.
    workspace = "account-b";
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    // A file that lists no login cannot show whether the next one is the same.
    listsIdentity = false;
    refused = false;
    yield* read;
    refused = true;
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (new URL(request.url).pathname.endsWith("/auth-files")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  files: [
                    {
                      id: "first.json",
                      auth_index: "a",
                      provider: "codex",
                      ...(listsIdentity
                        ? {
                            email: "first@example.com",
                            id_token: { chatgpt_account_id: workspace },
                          }
                        : {}),
                    },
                  ],
                }),
              );
            }
            const usage = {
              plan_type: "pro",
              rate_limit: {
                secondary_window: {
                  used_percent: 78,
                  reset_at: 4070908800,
                  limit_window_seconds: 604800,
                },
              },
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                refused
                  ? { status_code: 429, body: "{}" }
                  : { status_code: 200, body: JSON.stringify(usage) },
              ),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    models?: ReadonlyArray<string>;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    ...(account.models ? { models: account.models } : {}),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  // regression: #30778 only the accounts the hub routes the model to can refill it
  {
    name: "an account of another driver the hub routes the model to counts",
    accounts: [
      { driver: "codex", models: ["gpt-5.6-sol"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.6-sol",
    expected: at(3),
  },
  {
    name: "an account that lists no models is left out of an alias",
    accounts: [{ windows: [spent("five_hour", 1)] }, { models: [], windows: [] }],
    model: "opus",
    expected: at(1),
  },
  {
    name: "a spent Gemini quota does not hold back Claude on Antigravity",
    accounts: [
      {
        driver: "antigravity",
        models: ["claude-opus-4-6-thinking"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "claude-opus-4-6-thinking",
    expected: at(1),
  },
  {
    name: "a hub thinking suffix routes by its base model",
    accounts: [
      { driver: "codex", models: ["gpt-5.2"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.2(high)",
    expected: at(3),
  },
  {
    name: "a prefixed Gemini model is held back by the Gemini quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["ag/gemini-3.1-pro-high"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "ag/gemini-3.1-pro-high",
    expected: at(24),
  },
  {
    name: "an alias of unknown family is held back by every Antigravity quota",
    accounts: [{ driver: "antigravity", models: ["fast"], windows: [spent("gemini-5h", 24)] }],
    model: "fast",
    expected: at(24),
  },
  {
    name: "an own-driver account whose model list was unread still counts",
    accounts: [
      { windows: [spent("five_hour", 1)] },
      {
        driver: "antigravity",
        models: ["claude-sonnet-4-6"],
        windows: [spent("3p-5h", 8)],
      },
    ],
    model: "claude-sonnet-4-6",
    expected: at(1),
  },
  {
    name: "an Argon model waits only for the Argon quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["gemini-4-argon-high"],
        windows: [spent("gemini-argon-5h", 2), spent("gemini-carbon-weekly", 96)],
      },
    ],
    model: "gemini-4-argon-high",
    expected: at(2),
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);
