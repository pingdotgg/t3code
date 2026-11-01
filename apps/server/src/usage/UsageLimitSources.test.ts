import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ServerConfigStreamEvent,
  ServerSettingsError,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
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

const hubId = UsageLimitSourceId.make("hub");
const hubConfig = {
  kind: "cliproxy",
  url: "https://hub.test",
  managementKey: "test-key",
  enabled: true,
} as const;
const hubFiles = [
  {
    id: "a.json",
    auth_index: "a",
    provider: "codex",
    email: "a@example.com",
    id_token: { chatgpt_account_id: "ws-a" },
  },
  { id: "b.json", auth_index: "b", provider: "claude", email: "b@example.com" },
];
const decodeProbe = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ auth_index: Schema.String, url: Schema.String })),
);
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const makeHubTest = Effect.fn("test.makeHubTest")(function* (failed: string[] = []) {
  const baseSettings = yield* ServerSettings.ServerSettingsService;
  const changeObserved = yield* Deferred.make<void>();
  const changes = yield* Queue.unbounded<import("@t3tools/contracts").ServerSettings>();
  const settings = {
    ...baseSettings,
    streamChanges: Stream.fromQueue(changes).pipe(
      Stream.flatMap((next) =>
        Stream.make(next).pipe(Stream.ensuring(Deferred.succeed(changeObserved, undefined))),
      ),
    ),
    updateSettings: (...args: Parameters<typeof baseSettings.updateSettings>) =>
      baseSettings.updateSettings(...args).pipe(Effect.tap((next) => Queue.offer(changes, next))),
  };
  const readStarted = yield* Deferred.make<void>();
  const releaseRead = yield* Deferred.make<void>();
  const mode = yield* Ref.make({
    blocked: false,
    listFailed: false,
    failed,
    files: hubFiles,
    percent: 40,
    settingsFailed: false,
  });
  const sources = yield* UsageLimitSources.make.pipe(
    Effect.provide([
      Layer.succeed(ServerSettings.ServerSettingsService, {
        ...settings,
        getSettings: Effect.gen(function* () {
          if ((yield* Ref.get(mode)).settingsFailed)
            return yield* new ServerSettingsError({ settingsPath: "test", operation: "read-file" });
          return yield* settings.getSettings;
        }),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(mode);
            if (current.blocked) {
              yield* Deferred.succeed(readStarted, undefined);
              yield* Deferred.await(releaseRead);
            }
            if (new URL(request.url).pathname.endsWith("/auth-files"))
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ files: current.files }, { status: current.listFailed ? 503 : 200 }),
              );
            if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing probe body");
            const body = decodeProbe(new TextDecoder().decode(request.body.body));
            const failed = current.failed.includes(body.auth_index);
            const upstream = body.url.endsWith("/rate-limit-reset-credits")
              ? {
                  credits: [
                    {
                      id: "credit",
                      expires_at: "2099-01-01T00:00:00Z",
                      status: "available",
                      reset_type: "codex_rate_limits",
                    },
                  ],
                }
              : body.auth_index === "a"
                ? {
                    plan_type: "pro",
                    rate_limit: {
                      primary_window: {
                        used_percent: current.percent,
                        limit_window_seconds: 18000,
                        reset_at: 4070908800,
                      },
                    },
                  }
                : {
                    five_hour: { utilization: current.percent, resets_at: "2099-01-01T00:00:00Z" },
                  };
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ status_code: failed ? 503 : 200, body: encodeBody(upstream) }),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
  yield* sources.streamChanges.pipe(
    Stream.filter((snapshots) => snapshots.length === 1),
    Stream.runHead,
  );
  return { sources, settings, mode, readStarted, releaseRead, changeObserved };
});
const provideHubTest = <A, E>(
  effect: Effect.Effect<A, E, ServerSettings.ServerSettingsService | import("effect/Scope").Scope>,
) =>
  effect.pipe(
    Effect.provide(
      ServerSettings.layerTest({
        providerHealthRefreshInterval: Duration.seconds(0),
        usageLimitSources: { [hubId]: hubConfig },
      }),
    ),
    Effect.scoped,
  );

it.effect("retains last good accounts through source and account failures, then recovers", () =>
  provideHubTest(
    Effect.gen(function* () {
      const { sources, mode } = yield* makeHubTest();
      const good = (yield* sources.current)[0]!;
      expect(good.accounts).toHaveLength(2);
      expect(good.accounts[0]?.usageLimits.resetCredits?.availableCount).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* Ref.update(mode, (m) => ({ ...m, listFailed: true }));
      yield* sources.refresh;
      const failed = (yield* sources.current)[0]!;
      expect(failed.error).toBeDefined();
      expect(failed.accounts.map((a) => a.id)).toEqual(good.accounts.map((a) => a.id));
      for (const [index, account] of failed.accounts.entries()) {
        expect(account.usageLimits.windows).toEqual(good.accounts[index]?.usageLimits.windows);
        expect(account.usageLimits.checkedAt).toBe(good.accounts[index]?.usageLimits.checkedAt);
        expect(account.usageLimits.unavailable?.reason).toBe("probeFailed");
        expect(account.usageLimits.resetCredits).toBeUndefined();
      }
      yield* Ref.update(mode, (m) => ({ ...m, listFailed: false, failed: ["a"], percent: 60 }));
      yield* sources.refresh;
      const partial = (yield* sources.current)[0]!;
      expect(partial.error).toBeUndefined();
      expect(partial.accounts[0]?.usageLimits.windows).toEqual(
        good.accounts[0]?.usageLimits.windows,
      );
      expect(partial.accounts[0]?.usageLimits.checkedAt).toBe(
        good.accounts[0]?.usageLimits.checkedAt,
      );
      expect(partial.accounts[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(partial.accounts[1]?.usageLimits.windows[0]?.usedPercent).toBe(60);
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.checkedAt).toBe(
        good.accounts[0]?.usageLimits.checkedAt,
      );
      yield* Ref.update(mode, (m) => ({ ...m, failed: [], percent: 80 }));
      yield* sources.refresh;
      const recovered = (yield* sources.current)[0]!;
      expect(recovered.accounts[0]?.usageLimits.unavailable).toBeUndefined();
      expect(recovered.accounts[0]?.usageLimits.checkedAt).not.toBe(
        good.accounts[0]?.usageLimits.checkedAt,
      );
      expect(recovered.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(80);
    }),
  ),
);

it.effect("keeps settings read failure from publishing an authoritative removal", () =>
  provideHubTest(
    Effect.gen(function* () {
      const { sources, mode } = yield* makeHubTest();
      const good = yield* sources.current;
      yield* Ref.update(mode, (m) => ({ ...m, settingsFailed: true }));
      yield* sources.refresh;
      expect(yield* sources.current).toEqual(good);
    }),
  ),
);

it.effect(
  "clears removed accounts and does not invent a first sample or cross account identities",
  () =>
    provideHubTest(
      Effect.gen(function* () {
        const { sources, mode } = yield* makeHubTest();
        yield* Ref.update(mode, (m) => ({ ...m, files: [] }));
        yield* sources.refresh;
        expect((yield* sources.current)[0]?.accounts).toEqual([]);
        yield* Ref.update(mode, (m) => ({ ...m, files: hubFiles, failed: ["a"] }));
        yield* sources.refresh;
        expect((yield* sources.current)[0]?.accounts[0]?.usageLimits).toMatchObject({
          windows: [],
          unavailable: { reason: "probeFailed" },
        });
        yield* Ref.update(mode, (m) => ({ ...m, failed: [] }));
        yield* sources.refresh;
        for (const replacement of [
          { ...hubFiles[0]!, email: "other@example.com" },
          { ...hubFiles[0]!, id_token: { chatgpt_account_id: "other-workspace" } },
          { ...hubFiles[0]!, provider: "claude" },
        ]) {
          yield* Ref.update(mode, (m) => ({ ...m, files: hubFiles, failed: [] }));
          yield* sources.refresh;
          yield* Ref.update(mode, (m) => ({ ...m, files: [replacement], failed: ["a"] }));
          yield* sources.refresh;
          expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.windows).toEqual([]);
        }
      }),
    ),
);

it.effect.each([
  { name: "credential", patch: { ...hubConfig, managementKey: "replacement-key" } },
  { name: "URL", patch: { ...hubConfig, url: "https://different.test" } },
  { name: "label", patch: { ...hubConfig, label: "Different source" } },
  { name: "disabled", patch: { ...hubConfig, enabled: false } },
  { name: "removed", patch: null },
])("discards cache for a $name source change, including after restoring the config", ({ patch }) =>
  provideHubTest(
    Effect.gen(function* () {
      const { sources, settings, mode } = yield* makeHubTest();
      yield* Ref.update(mode, (m) => ({ ...m, listFailed: true }));
      yield* settings.updateSettings({ usageLimitSources: { [hubId]: patch } });
      yield* sources.refresh;
      expect((yield* sources.current).flatMap((s) => s.accounts)).toEqual([]);
      yield* settings.updateSettings({ usageLimitSources: { [hubId]: hubConfig } });
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts).toEqual([]);
    }),
  ),
);

it.effect(
  "invalidates cached accounts when a source is disabled and restored during a refresh",
  () =>
    provideHubTest(
      Effect.gen(function* () {
        const { sources, settings, mode, readStarted, releaseRead, changeObserved } =
          yield* makeHubTest();
        yield* Ref.update(mode, (m) => ({ ...m, blocked: true, listFailed: true }));
        const pending = yield* sources.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(readStarted);
        yield* settings.updateSettings({
          usageLimitSources: { [hubId]: { ...hubConfig, enabled: false } },
        });
        yield* settings.updateSettings({ usageLimitSources: { [hubId]: hubConfig } });
        yield* Ref.update(mode, (m) => ({ ...m, blocked: false }));
        yield* Deferred.succeed(releaseRead, undefined);
        yield* Fiber.join(pending);
        yield* Deferred.await(changeObserved);
        yield* sources.refresh;
        expect((yield* sources.current)[0]?.accounts).toEqual([]);
      }),
    ),
);

it.effect("retains known windows when routing-disabled accounts fail a read-only probe", () =>
  provideHubTest(
    Effect.gen(function* () {
      const { sources, mode } = yield* makeHubTest();
      const good = (yield* sources.current)[0]!.accounts;
      yield* Ref.update(mode, (m) => ({
        ...m,
        files: hubFiles.map((a) => ({ ...a, disabled: true })),
        failed: ["a", "b"],
      }));
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts.map((a) => a.usageLimits.windows)).toEqual(
        good.map((a) => a.usageLimits.windows),
      );
      expect(
        (yield* sources.current)[0]?.accounts.every(
          (a) => a.usageLimits.unavailable?.reason === "probeFailed",
        ),
      ).toBe(true);
    }),
  ),
);

it.effect("publishes account-specific failures before any account has a good sample", () =>
  provideHubTest(
    Effect.gen(function* () {
      const { sources } = yield* makeHubTest(["a", "b"]);
      const snapshot = (yield* sources.current)[0]!;
      expect(snapshot.error).toBeUndefined();
      expect(snapshot.accounts.map((a) => a.id)).toEqual(["a.json", "b.json"]);
      for (const account of snapshot.accounts) {
        expect(account.usageLimits.windows).toEqual([]);
        expect(account.usageLimits.unavailable).toMatchObject({
          reason: "probeFailed",
          message: expect.any(String),
        });
        expect(account.usageLimits.resetCredits).toBeUndefined();
      }
    }),
  ),
);
