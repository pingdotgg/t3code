import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { SandboxId, type CloudSandboxRecord } from "@t3tools/contracts";
import { layerSandboxProviderRegistry, SandboxProvider } from "@t3tools/sandbox-providers";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { SandboxConfig } from "./SandboxConfig.ts";
import { SandboxNotifier, type SandboxNotificationPayload } from "./SandboxNotificationHook.ts";
import * as SandboxOrchestratorService from "./SandboxOrchestratorService.ts";
import * as SandboxRepository from "./SandboxRepository.ts";
import * as SandboxWatchdogService from "./SandboxWatchdogService.ts";

describe("SandboxWatchdogService", () => {
  it.effect(
    "auto-pauses idle sandboxes after 8 min with 0 running turns and guards Vercel Hobby at 40m warn + 43m auto-snapshot",
    () =>
      Effect.gen(function* () {
        const notifications: SandboxNotificationPayload[] = [];
        const pausedIds: string[] = [];
        const snapshottedIds: string[] = [];
        let activeRunsBySandbox: Record<string, number> = {};

        const makeMockDriver = (kind: "codesandbox" | "vercel-sandbox") =>
          SandboxProvider.of({
            kind,
            create: () => Effect.die("unused"),
            exec: () => Effect.die("unused"),
            snapshot: (input) =>
              Effect.sync(() => {
                snapshottedIds.push(input.providerSandboxId);
                return {
                  snapshotId: `auto-snap-${input.providerSandboxId}`,
                  stoppedAfterSnapshot: true,
                };
              }),
            pauseOrStop: (providerSandboxId) =>
              Effect.sync(() => {
                pausedIds.push(providerSandboxId);
                return { state: "paused" as const };
              }),
            resume: () => Effect.die("unused"),
            getStatus: (providerSandboxId) =>
              Effect.succeed({ providerSandboxId, state: "running" as const }),
            destroy: () => Effect.void,
            getPublicUrl: () => Effect.succeed(null),
          });

        const baseInfra = Layer.mergeAll(
          SandboxRepository.layer,
          layerSandboxProviderRegistry([
            {
              provider: "codesandbox",
              driver: makeMockDriver("codesandbox"),
              defaultSnapshotId: null,
            },
            { provider: "upstash-box", driver: null, defaultSnapshotId: null },
            {
              provider: "vercel-sandbox",
              driver: makeMockDriver("vercel-sandbox"),
              defaultSnapshotId: null,
            },
          ]),
          Layer.succeed(
            SandboxConfig,
            SandboxConfig.of({
              defaultIdleTimeoutMinutes: 8,
              codesandboxApiKey: Option.none(),
              upstashBoxApiKey: Option.none(),
              vercelOidcToken: Option.none(),
              vercelToken: Option.none(),
              vercelTeamId: Option.none(),
              vercelProjectId: Option.none(),
              defaultSnapshots: { codesandbox: null, upstashBox: null, vercelSandbox: null },
              passthroughSecrets: {},
            }),
          ),
        ).pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(NodeCrypto.layer),
        );

        const orchestratorLayer = SandboxOrchestratorService.layer.pipe(
          Layer.provideMerge(baseInfra),
        );

        const watchdogLayer = SandboxWatchdogService.layer.pipe(
          Layer.provideMerge(orchestratorLayer),
          Layer.provide(
            Layer.succeed(
              SandboxNotifier,
              SandboxNotifier.of({
                notify: (payload) =>
                  Effect.sync(() => {
                    notifications.push(payload);
                  }),
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              SandboxWatchdogService.SandboxActivityProbe,
              SandboxWatchdogService.SandboxActivityProbe.of({
                probe: (sandbox) =>
                  Effect.succeed({
                    activeRunCount: activeRunsBySandbox[sandbox.id] ?? 0,
                    lastRunActivityAt: null,
                    reachable: true,
                  }),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const repository = yield* SandboxRepository.SandboxRepository;
          const watchdog = yield* SandboxWatchdogService.SandboxWatchdogService;

          const startIso = DateTime.formatIso(yield* DateTime.now);
          const csbRecord: CloudSandboxRecord = {
            id: SandboxId.make("sb-csb-idle"),
            provider: "codesandbox",
            providerSandboxId: "csb-remote-1",
            name: "csb-dev",
            snapshotId: null,
            baseSnapshotId: null,
            repoUrl: null,
            branch: null,
            agentHarness: null,
            connectionUrl: "https://csb-1.csb.app",
            environmentId: null,
            state: "running",
            idleTimeoutMinutes: 8,
            startedAt: startIso,
            lastActivityAt: startIso,
            pausedAt: null,
            vercelWarnedAt: null,
            lastError: null,
            createdAt: startIso,
            updatedAt: startIso,
          };
          const vercelRecord: CloudSandboxRecord = {
            ...csbRecord,
            id: SandboxId.make("sb-vercel-hobby"),
            provider: "vercel-sandbox",
            providerSandboxId: "vercel-remote-1",
            name: "vercel-dev",
            connectionUrl: "https://vercel-1.vercel.run",
            idleTimeoutMinutes: 60,
          };

          yield* repository.insert(csbRecord);
          yield* repository.insert(vercelRecord);

          // Active turn keeps CodeSandbox alive past 8 minutes
          activeRunsBySandbox = { "sb-csb-idle": 1, "sb-vercel-hobby": 1 };
          yield* TestClock.adjust(Duration.minutes(10));
          const sweepWhileBusy = yield* watchdog.runOnce;
          expect(sweepWhileBusy.pausedForIdle).toBe(0);
          expect(pausedIds).toHaveLength(0);

          // Turns finish on CodeSandbox; 8 minutes later it auto-pauses
          activeRunsBySandbox = { "sb-csb-idle": 0, "sb-vercel-hobby": 1 };
          yield* TestClock.adjust(Duration.minutes(8));
          const sweepIdle = yield* watchdog.runOnce;
          expect(sweepIdle.pausedForIdle).toBe(1);
          expect(pausedIds).toEqual(["csb-remote-1"]);
          expect(notifications.some((n) => n.event === "sandbox_auto_stopped")).toBe(true);

          // Advance to 40 minutes total runtime for Vercel Sandbox -> warning fired once
          yield* TestClock.adjust(Duration.minutes(22));
          const sweepWarn = yield* watchdog.runOnce;
          expect(sweepWarn.vercelWarned).toBe(1);
          expect(notifications.filter((n) => n.event === "sandbox_warning")).toHaveLength(1);

          // Re-sweeping at 41 minutes does not duplicate the warning
          yield* TestClock.adjust(Duration.minutes(1));
          const sweepNoDup = yield* watchdog.runOnce;
          expect(sweepNoDup.vercelWarned).toBe(0);
          expect(notifications.filter((n) => n.event === "sandbox_warning")).toHaveLength(1);

          // Advance to 43 minutes -> auto-snapshot & pause before 45-min Hobby ceiling
          yield* TestClock.adjust(Duration.minutes(2));
          const sweepSnap = yield* watchdog.runOnce;
          expect(sweepSnap.vercelAutoSnapshotted).toBe(1);
          expect(snapshottedIds).toEqual(["vercel-remote-1"]);
          const updatedVercel = yield* repository.findById(SandboxId.make("sb-vercel-hobby"));
          expect(Option.isSome(updatedVercel)).toBe(true);
          if (Option.isSome(updatedVercel)) {
            expect(updatedVercel.value.state).toBe("paused");
            expect(updatedVercel.value.snapshotId).toBe("auto-snap-vercel-remote-1");
          }
        }).pipe(Effect.provide(watchdogLayer));
      }),
  );
});
