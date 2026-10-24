import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderUsage from "./ProviderUsage.ts";

const makeProvider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const claudeLimits: ServerProviderUsageLimits = {
  checkedAt: "2026-10-24T08:12:00.000Z",
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 42,
      windowDurationMins: 300,
      resetsAt: "2026-10-24T12:40:00.000Z",
    },
    {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 61.5,
      windowDurationMins: 10080,
      model: "Fable",
    },
  ],
};

const claudeWindows = [
  {
    id: "five_hour",
    kind: "session",
    usedPercent: 42,
    resetsAt: "2026-10-24T12:40:00.000Z",
    scope: "account",
  },
  {
    id: "seven_day_fable",
    kind: "weekly",
    usedPercent: 61.5,
    resetsAt: null,
    scope: "model:Fable",
  },
] as const;

/** One server session: the registry serves `providers` and publishes `changes`. */
const readSession = (
  baseDir: string,
  providers: ReadonlyArray<ServerProvider>,
  changes: Stream.Stream<ReadonlyArray<ServerProvider>> = Stream.never,
  beforeRead: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const usage = yield* ProviderUsage.ProviderUsage;
    yield* beforeRead;
    return yield* usage.read({});
  }).pipe(
    Effect.provide(
      ProviderUsage.layer.pipe(
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(providers),
            streamChanges: changes,
          }),
        ),
        Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      ),
    ),
  );

/** A session in which the registry publishes each snapshot in turn; returns after they are saved. */
const observe = (baseDir: string, ...snapshots: ReadonlyArray<ServerProvider>) =>
  Effect.gen(function* () {
    // The change stream is consumed in order, so `persisted` completes only
    // after the observation before it has been written.
    const persisted = yield* Deferred.make<void>();
    return yield* readSession(
      baseDir,
      snapshots.slice(-1),
      Stream.concat(
        Stream.fromIterable(snapshots.map((snapshot) => [snapshot])),
        Stream.fromEffect(Deferred.succeed(persisted, undefined)).pipe(Stream.drain),
      ),
      Deferred.await(persisted),
    );
  });

const claudeAuth = (email: string): ServerProvider["auth"] => ({
  status: "authenticated",
  email,
});

it.layer(NodeServices.layer)("ProviderUsage", (it) => {
  it.effect("reports an enabled provider that has reported nothing as none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const result = yield* readSession(baseDir, [
        makeProvider("opencode"),
        makeProvider("cursor", { enabled: false }),
      ]);
      assert.deepStrictEqual(result, {
        providers: [
          {
            providerInstanceId: ProviderInstanceId.make("opencode"),
            driverKind: ProviderDriverKind.make("opencode"),
            measuredAt: null,
            source: "none",
            windows: [],
          },
        ],
      });
    }),
  );

  it.effect("answers with the last observation as stale after a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const first = yield* observe(
        baseDir,
        makeProvider("claudeAgent", {
          usageLimits: claudeLimits,
          auth: claudeAuth("a@example.com"),
        }),
      );
      assert.strictEqual(first.providers[0]?.source, "observed");

      const restarted = yield* readSession(baseDir, [
        makeProvider("claudeAgent", { auth: claudeAuth("A@example.com") }),
      ]);
      assert.deepStrictEqual(restarted.providers, [
        {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          measuredAt: "2026-10-24T08:12:00.000Z",
          source: "stale",
          windows: claudeWindows,
        },
      ]);
    }),
  );

  it.effect("does not show another account's observation after a switch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      yield* observe(
        baseDir,
        makeProvider("claudeAgent", {
          usageLimits: claudeLimits,
          auth: claudeAuth("a@example.com"),
        }),
      );

      const switched = yield* readSession(baseDir, [
        makeProvider("claudeAgent", { auth: claudeAuth("b@example.com") }),
      ]);
      assert.strictEqual(switched.providers[0]?.source, "none");
    }),
  );

  it.effect("saves a changed observation that shares the previous checkedAt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const [session, weekly] = claudeLimits.windows;
      yield* observe(
        baseDir,
        makeProvider("claudeAgent", { usageLimits: claudeLimits }),
        makeProvider("claudeAgent", {
          usageLimits: { ...claudeLimits, windows: [{ ...session!, usedPercent: 43 }, weekly!] },
        }),
      );

      const restarted = yield* readSession(baseDir, [makeProvider("claudeAgent")]);
      assert.strictEqual(restarted.providers[0]?.windows[0]?.usedPercent, 43);
    }),
  );
});
