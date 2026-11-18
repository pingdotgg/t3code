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
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
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

it.effect("reads routed sessions from opted-in hubs, even with no client open", () =>
  Effect.gen(function* () {
    const queueReads: string[] = [];
    let refused = false;
    let email = "account@example.com";
    let accountId = "claude-a.json";
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.headers.authorization).toBe("Bearer key");
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
              files: [
                {
                  id: accountId,
                  auth_index: "a",
                  provider: "claude",
                  email,
                },
              ],
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            status_code: refused ? 429 : 200,
            body: JSON.stringify({
              five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" },
            }),
          }),
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

    email = "replacement@example.com";
    yield* TestClock.adjust("30 seconds");
    expect((yield* sources.current)[0]?.accounts[0]?.sessionIds).toBeUndefined();
    yield* sources.refresh;
    const replaced = yield* sources.current;
    expect(replaced[0]?.accounts[0]?.sessionIds).toBeUndefined();
    yield* TestClock.adjust("30 seconds");
    expect((yield* sources.current)[0]?.accounts[0]?.sessionIds).toEqual(["thread-session"]);

    accountId = "claude-b.json";
    yield* TestClock.adjust("30 seconds");
    expect((yield* sources.current)[0]?.accounts[0]?.sessionIds).toBeUndefined();
    yield* sources.refresh;
    yield* TestClock.adjust("30 seconds");
    expect((yield* sources.current)[0]?.accounts[0]?.sessionIds).toEqual(["thread-session"]);

    refused = true;
    // Switching Thread accounts off drops the routes on that refresh, not on the next queue read.
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      usageLimitSources: {
        [UsageLimitSourceId.make("routed")]: {
          kind: "cliproxy",
          url: "https://routed.test",
          managementKey: "key",
          enabled: true,
          threadAccounts: false,
        },
      },
    });
    yield* sources.refresh;
    const afterOff = yield* sources.current;
    expect(afterOff[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
    expect(afterOff.find((source) => source.id === "routed")?.accounts[0]?.sessionIds).toBe(
      undefined,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) => Effect.succeed(references.map(() => "key")),
        invalidate: () => Effect.void,
        label: (provider) => Effect.succeed(provider),
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("routed")]: {
            kind: "cliproxy",
            url: "https://routed.test",
            managementKey: {
              provider: SecretProviderId.make("homelab"),
              reference: "cliproxy#key",
            },
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
      // No client lease: a turn that ends while nobody watches must still keep its route.
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("drops a queue read that lands after Thread accounts was switched off", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const clock = yield* Clock.Clock;
    let returned = false;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/usage-queue")) {
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.tap(() =>
            Effect.sync(() => {
              returned = true;
            }),
          ),
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              Response.json([{ session_id: "thread-session", auth_index: "a" }]),
            ),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith("/auth-files")
            ? Response.json({
                files: [{ id: "claude-a.json", auth_index: "a", provider: "claude" }],
              })
            : Response.json({ status_code: 200, body: JSON.stringify({}) }),
        ),
      );
    });
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(Clock.Clock, {
        ...clock,
        sleep: (duration) =>
          (returned && Duration.equals(duration, Duration.seconds(30))
            ? Deferred.succeed(completed, undefined)
            : Effect.void
          ).pipe(Effect.andThen(clock.sleep(duration))),
      }),
    );
    yield* sources.refresh;
    yield* TestClock.adjust("30 seconds");
    yield* Deferred.await(started);

    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      usageLimitSources: {
        [UsageLimitSourceId.make("routed")]: {
          kind: "cliproxy",
          url: "https://routed.test",
          managementKey: "key",
          enabled: true,
          threadAccounts: false,
        },
      },
    });
    yield* sources.refresh;
    yield* Deferred.succeed(release, undefined);
    // The next queue interval starts only after the late read finishes publishing.
    yield* Deferred.await(completed);

    const snapshots = yield* sources.current;
    expect(snapshots[0]?.accounts[0]?.sessionIds).toBe(undefined);
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
        label: (provider) => Effect.succeed(provider),
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("routed")]: {
            kind: "cliproxy",
            url: "https://routed.test",
            managementKey: "key",
            enabled: true,
            threadAccounts: true,
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
