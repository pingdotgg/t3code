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

const makeProvider = (
  driver: string,
  usageLimits?: ServerProviderUsageLimits,
  enabled = true,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...(usageLimits ? { usageLimits } : {}),
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

it.layer(NodeServices.layer)("ProviderUsage", (it) => {
  it.effect("reports an enabled provider that has reported nothing as none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const result = yield* readSession(baseDir, [
        makeProvider("opencode"),
        makeProvider("cursor", undefined, false),
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
      const claude = makeProvider("claudeAgent", claudeLimits);

      // The change stream is consumed in order, so `persisted` completes only
      // after the observation before it has been written.
      const persisted = yield* Deferred.make<void>();
      const first = yield* readSession(
        baseDir,
        [claude],
        Stream.concat(
          Stream.make([claude]),
          Stream.fromEffect(Deferred.succeed(persisted, undefined)).pipe(Stream.drain),
        ),
        Deferred.await(persisted),
      );
      assert.strictEqual(first.providers[0]?.source, "observed");

      const restarted = yield* readSession(baseDir, [makeProvider("claudeAgent")]);
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
});
