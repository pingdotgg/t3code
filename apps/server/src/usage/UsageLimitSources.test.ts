import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

it("waits for the first refill only when every pooled account of the driver is spent", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const claude = ProviderDriverKind.make("claudeAgent");
  const account = (id: string, windows: ReadonlyArray<object>, models?: ReadonlyArray<string>) => ({
    id,
    driver: claude,
    ...(models ? { models } : {}),
    usageLimits: { checkedAt: "2026-11-06T12:00:00.000Z", windows },
  });
  const session = (usedPercent: number, resetsAt: string) => ({
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt,
  });
  const hub = (accounts: ReadonlyArray<ReturnType<typeof account>>) =>
    [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy",
        label: "Hub",
        checkedAt: "",
        accounts,
      },
    ] as never;
  const spent = [
    account("a", [session(100, "2026-11-06T14:00:00.000Z")]),
    account("b", [
      session(100, "2026-11-06T13:00:00.000Z"),
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        usedPercent: 100,
        resetsAt: "2026-11-10T00:00:00.000Z",
      },
    ]),
  ];
  // regression: #30778 a spent Fable allowance does not hold back other models
  expect(UsageLimitSources.hubPoolResetAt(hub(spent), claude, null, now)).toBe(
    "2026-11-06T13:00:00.000Z",
  );
  expect(UsageLimitSources.hubPoolResetAt(hub(spent), claude, "claude-sonnet-5-5", now)).toBe(
    "2026-11-06T13:00:00.000Z",
  );
  expect(UsageLimitSources.hubPoolResetAt(hub(spent), claude, "claude-fable-5-2", now)).toBe(
    "2026-11-06T14:00:00.000Z",
  );
  const idle = account("idle", [session(20, "2026-11-06T15:00:00.000Z")], []);
  expect(UsageLimitSources.hubPoolResetAt(hub([...spent, idle]), claude, "opus", now)).toBe(
    "2026-11-06T13:00:00.000Z",
  );
  const withRoom = [...spent, account("c", [session(40, "2026-11-06T15:00:00.000Z")])];
  expect(UsageLimitSources.hubPoolResetAt(hub(withRoom), claude, null, now)).toBeNull();
  const unread = {
    id: "d",
    driver: claude,
    usageLimits: { checkedAt: "", windows: [], unavailable: { reason: "probeFailed" } },
  };
  expect(UsageLimitSources.hubPoolResetAt(hub([...spent, unread]), claude, null, now)).toBeNull();
  expect(
    UsageLimitSources.hubPoolResetAt(hub(spent), ProviderDriverKind.make("codex"), null, now),
  ).toBeNull();
  const routed = [
    account("opus", [session(100, "2026-11-06T13:00:00.000Z")], ["claude-opus-5-5"]),
    account("sonnet", [session(40, "2026-11-06T15:00:00.000Z")], ["claude-sonnet-5-5"]),
  ];
  expect(UsageLimitSources.hubPoolResetAt(hub(routed), claude, "claude-opus-5-5[1m]", now)).toBe(
    "2026-11-06T13:00:00.000Z",
  );
  expect(UsageLimitSources.hubPoolResetAt(hub(routed), claude, null, now)).toBeNull();
  const unlisted = account("unlisted", [session(30, "2026-11-06T15:00:00.000Z")]);
  expect(
    UsageLimitSources.hubPoolResetAt(hub([...routed, unlisted]), claude, "claude-opus-5-5", now),
  ).toBeNull();
  // regression: #30778 a spent Gemini quota does not hold back Claude on an Antigravity account
  const antigravity = {
    ...account("ag", [
      { ...session(100, "2026-11-06T13:00:00.000Z"), id: "3p-5h" },
      { ...session(100, "2026-11-07T12:00:00.000Z"), id: "gemini-5h" },
    ]),
    driver: ProviderDriverKind.make("antigravity"),
    models: ["claude-opus-4-6-thinking", "gemini-3-pro"],
  };
  expect(
    UsageLimitSources.hubPoolResetAt(hub([antigravity]), claude, "claude-opus-4-6-thinking", now),
  ).toBe("2026-11-06T13:00:00.000Z");
});

it.effect("takes a reset only from the hub at the instance's endpoint", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const spentHub = (id: string, origin: string) => ({
    id: UsageLimitSourceId.make(id),
    kind: "cliproxy" as const,
    label: id,
    origin,
    checkedAt: "2026-11-06T12:00:00.000Z",
    accounts: [
      {
        id: "a",
        driver: claude,
        usageLimits: {
          checkedAt: "2026-11-06T12:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session" as const,
              label: "Session",
              usedPercent: 100,
              resetsAt: `2026-11-06T1${id === "home" ? 3 : 4}:00:00.000Z`,
            },
          ],
        },
      },
    ],
  });
  return Effect.gen(function* () {
    const fallback = yield* UsageLimitSources.UsageLimitResetFallback;
    expect(yield* fallback.resetAt(claude, "http://home:8317", null)).toBe(
      "2026-11-06T13:00:00.000Z",
    );
    // regression: #30778 a gateway that is not a configured hub gets no hub's reset
    expect(yield* fallback.resetAt(claude, "http://gateway:8080", null)).toBeNull();
  }).pipe(
    Effect.provide(
      UsageLimitSources.layerResetFallback.pipe(
        Layer.provide(
          Layer.mock(UsageLimitSources.UsageLimitSources)({
            current: Effect.succeed([
              spentHub("home", "http://home:8317"),
              spentHub("work", "http://work:8317"),
            ]),
            refresh: Effect.die("hub refresh"),
          }),
        ),
      ),
    ),
  );
});
