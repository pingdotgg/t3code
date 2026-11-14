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
