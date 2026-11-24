import { SandboxActivityReport, type CloudSandboxRecord } from "@t3tools/contracts";
import {
  SandboxProviderRegistry,
  VERCEL_HOBBY_CEILING_MINUTES,
  VERCEL_HOBBY_SNAPSHOT_MINUTES,
  VERCEL_HOBBY_WARNING_MINUTES,
} from "@t3tools/sandbox-providers";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import { SandboxNotifier } from "./SandboxNotificationHook.ts";
import { SandboxOrchestratorService } from "./SandboxOrchestratorService.ts";
import { SandboxRepository } from "./SandboxRepository.ts";

// 1-minute cadence ensures Vercel's 43-min auto-snapshot always fires well before the 45-min ceiling.
const SANDBOX_WATCHDOG_INTERVAL = Duration.minutes(1);
const ACTIVITY_PROBE_TIMEOUT = Duration.seconds(5);
const STALE_TRANSITIONAL_STATE_MS = 15 * 60_000;

export interface SandboxActivityProbeResult {
  readonly activeRunCount: number;
  readonly lastRunActivityAt: string | null;
  readonly reachable: boolean;
}

export class SandboxActivityProbe extends Context.Service<
  SandboxActivityProbe,
  {
    readonly probe: (sandbox: CloudSandboxRecord) => Effect.Effect<SandboxActivityProbeResult>;
  }
>()("t3/sandboxes/SandboxWatchdogService/SandboxActivityProbe") {}

export interface SandboxWatchdogSweepResult {
  readonly checked: number;
  readonly pausedForIdle: number;
  readonly vercelWarned: number;
  readonly vercelAutoSnapshotted: number;
  readonly reconciledStopped: number;
}

export class SandboxWatchdogService extends Context.Service<
  SandboxWatchdogService,
  {
    readonly runOnce: Effect.Effect<SandboxWatchdogSweepResult>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/sandboxes/SandboxWatchdogService") {}

function parseEpochMillis(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

const makeHttpActivityProbe = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  return SandboxActivityProbe.of({
    probe: Effect.fn("SandboxActivityProbe.probe")(function* (sandbox) {
      if (sandbox.connectionUrl === null) {
        return {
          activeRunCount: 0,
          lastRunActivityAt: null,
          reachable: false,
        };
      }
      const endpoint = `${sandbox.connectionUrl.replace(/\/+$/u, "")}/api/sandboxes/activity`;
      const remote = yield* httpClient
        .execute(HttpClientRequest.get(endpoint))
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(SandboxActivityReport)),
          Effect.timeout(ACTIVITY_PROBE_TIMEOUT),
          Effect.option,
        );
      if (Option.isSome(remote)) {
        return {
          activeRunCount: remote.value.activeRunCount,
          lastRunActivityAt: remote.value.lastRunActivityAt,
          reachable: true,
        };
      }
      return {
        activeRunCount: 0,
        lastRunActivityAt: null,
        reachable: false,
      };
    }),
  });
});

export const layerActivityProbe = Layer.effect(SandboxActivityProbe, makeHttpActivityProbe);

const make = Effect.gen(function* () {
  const repository = yield* SandboxRepository;
  const registry = yield* SandboxProviderRegistry;
  const orchestrator = yield* SandboxOrchestratorService;
  const notifier = yield* SandboxNotifier;
  const activityProbe = yield* SandboxActivityProbe;

  const evaluateSandbox = Effect.fn("SandboxWatchdogService.evaluateSandbox")(function* (
    sandbox: CloudSandboxRecord,
    nowMs: number,
    nowIso: string,
  ) {
    const driver = yield* registry.get(sandbox.provider).pipe(Effect.option);
    if (Option.isNone(driver)) {
      return { changed: false, outcome: "skipped" as const };
    }

    // Vercel Sandbox Hobby ceiling guard: 40-min warning + 43-min auto-snapshot before 45-min hard stop.
    if (sandbox.provider === "vercel-sandbox") {
      const startedMs = parseEpochMillis(sandbox.startedAt);
      if (startedMs !== null) {
        const runningMinutes = (nowMs - startedMs) / 60_000;
        if (runningMinutes >= VERCEL_HOBBY_SNAPSHOT_MINUTES) {
          const snap = yield* driver.value
            .snapshot({
              providerSandboxId: sandbox.providerSandboxId,
              name: `${sandbox.name}-auto-43m`,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Vercel Sandbox 43-min auto-snapshot failed", {
                  sandboxId: sandbox.id,
                  cause,
                }),
              ),
              Effect.option,
            );
          if (Option.isSome(snap)) {
            yield* repository
              .update(sandbox.id, {
                state: "paused",
                snapshotId: snap.value.snapshotId,
                pausedAt: nowIso,
                vercelWarnedAt: sandbox.vercelWarnedAt ?? nowIso,
                lastError: null,
                updatedAt: nowIso,
              })
              .pipe(Effect.ignore);
            yield* notifier.notify({
              event: "sandbox_auto_stopped",
              title: `Vercel Sandbox auto-snapshotted: ${sandbox.name}`,
              body: `Saved snapshot ${snap.value.snapshotId} at ${VERCEL_HOBBY_SNAPSHOT_MINUTES}m before the ${VERCEL_HOBBY_CEILING_MINUTES}m Hobby limit. Resume anytime.`,
              priority: "high",
            });
            return { changed: true, outcome: "vercel_auto_snapshotted" as const };
          }
        } else if (
          runningMinutes >= VERCEL_HOBBY_WARNING_MINUTES &&
          sandbox.vercelWarnedAt === null
        ) {
          yield* repository
            .update(sandbox.id, {
              vercelWarnedAt: nowIso,
              updatedAt: nowIso,
            })
            .pipe(Effect.ignore);
          yield* notifier.notify({
            event: "sandbox_warning",
            title: `Vercel Sandbox approaching 45-min limit: ${sandbox.name}`,
            body: `Running for ${Math.floor(runningMinutes)}m. Auto-snapshot and pause will trigger at ${VERCEL_HOBBY_SNAPSHOT_MINUTES}m.`,
            priority: "high",
          });
          return { changed: true, outcome: "vercel_warned" as const };
        }
      }
    }

    const probe = yield* activityProbe.probe(sandbox);
    if (probe.activeRunCount > 0) {
      yield* repository
        .update(sandbox.id, {
          lastActivityAt: nowIso,
          updatedAt: nowIso,
        })
        .pipe(Effect.ignore);
      return { changed: false, outcome: "active" as const };
    }

    if (!probe.reachable) {
      const status = yield* driver.value.getStatus(sandbox.providerSandboxId).pipe(Effect.option);
      if (
        Option.isSome(status) &&
        (status.value.state === "paused" || status.value.state === "stopped")
      ) {
        yield* repository
          .update(sandbox.id, {
            state: status.value.state,
            ...(status.value.snapshotId !== undefined
              ? { snapshotId: status.value.snapshotId }
              : {}),
            pausedAt: nowIso,
            updatedAt: nowIso,
          })
          .pipe(Effect.ignore);
        return { changed: true, outcome: "reconciled_stopped" as const };
      }
    }

    const recordedActivityMs = parseEpochMillis(sandbox.lastActivityAt) ?? nowMs;
    const probeActivityMs = parseEpochMillis(probe.lastRunActivityAt);
    const effectiveActivityMs =
      probeActivityMs !== null ? Math.max(recordedActivityMs, probeActivityMs) : recordedActivityMs;
    const idleMs = nowMs - effectiveActivityMs;

    if (idleMs >= sandbox.idleTimeoutMinutes * 60_000) {
      const stopped = yield* driver.value.pauseOrStop(sandbox.providerSandboxId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Idle sandbox auto-reaper pause failed", {
            sandboxId: sandbox.id,
            provider: sandbox.provider,
            cause,
          }),
        ),
        Effect.option,
      );
      if (Option.isSome(stopped)) {
        yield* repository
          .update(sandbox.id, {
            state: stopped.value.state,
            ...(stopped.value.snapshotId !== undefined
              ? { snapshotId: stopped.value.snapshotId }
              : {}),
            pausedAt: nowIso,
            lastError: null,
            updatedAt: nowIso,
          })
          .pipe(Effect.ignore);
        yield* notifier.notify({
          event: "sandbox_auto_stopped",
          title: `Cloud sandbox auto-paused: ${sandbox.name}`,
          body: `Paused ${sandbox.provider} sandbox after ${sandbox.idleTimeoutMinutes}m with no running turns to protect free-tier credits.`,
          priority: "default",
        });
        return { changed: true, outcome: "paused_for_idle" as const };
      }
    }

    return { changed: false, outcome: "idle_within_budget" as const };
  });

  const runOnce = Effect.gen(function* () {
    const running = yield* repository
      .listByState("running")
      .pipe(Effect.orElseSucceed((): ReadonlyArray<CloudSandboxRecord> => []));
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);

    let pausedForIdle = 0;
    let vercelWarned = 0;
    let vercelAutoSnapshotted = 0;
    let reconciledStopped = 0;
    let anyChanged = false;

    for (const sandbox of running) {
      const result = yield* evaluateSandbox(sandbox, nowMs, nowIso);
      if (result.changed) anyChanged = true;
      switch (result.outcome) {
        case "paused_for_idle":
          pausedForIdle += 1;
          break;
        case "vercel_warned":
          vercelWarned += 1;
          break;
        case "vercel_auto_snapshotted":
          vercelAutoSnapshotted += 1;
          break;
        case "reconciled_stopped":
          reconciledStopped += 1;
          break;
        case "active":
        case "idle_within_budget":
        case "skipped":
          break;
      }
    }

    // Reconcile sandboxes left in transitional states after a host restart/crash.
    const allSandboxes = yield* repository
      .listAll()
      .pipe(Effect.orElseSucceed((): ReadonlyArray<CloudSandboxRecord> => []));
    for (const sandbox of allSandboxes) {
      if (
        sandbox.state !== "creating" &&
        sandbox.state !== "bootstrapping" &&
        sandbox.state !== "snapshotting" &&
        sandbox.state !== "destroying"
      ) {
        continue;
      }
      const updatedMs = parseEpochMillis(sandbox.updatedAt);
      if (updatedMs === null || nowMs - updatedMs < STALE_TRANSITIONAL_STATE_MS) {
        continue;
      }
      const driver = yield* registry.get(sandbox.provider).pipe(Effect.option);
      if (Option.isNone(driver)) continue;
      const status = yield* driver.value.getStatus(sandbox.providerSandboxId).pipe(Effect.option);
      const nextState = Option.isSome(status) ? status.value.state : ("error" as const);
      yield* repository
        .update(sandbox.id, {
          state: nextState,
          ...(Option.isSome(status) && status.value.snapshotId !== undefined
            ? { snapshotId: status.value.snapshotId }
            : {}),
          ...(nextState === "paused" || nextState === "stopped" ? { pausedAt: nowIso } : {}),
          ...(nextState === "error"
            ? { lastError: `Reconciled stale '${sandbox.state}' state after timeout.` }
            : {}),
          updatedAt: nowIso,
        })
        .pipe(Effect.ignore);
      if (nextState === "paused" || nextState === "stopped") {
        reconciledStopped += 1;
      }
      anyChanged = true;
    }

    if (anyChanged) {
      yield* orchestrator.publishRefresh();
    }

    return {
      checked: running.length,
      pausedForIdle,
      vercelWarned,
      vercelAutoSnapshotted,
      reconciledStopped,
    } satisfies SandboxWatchdogSweepResult;
  }).pipe(Effect.withSpan("SandboxWatchdogService.runOnce"));

  const start = () =>
    forkParked(
      runOnce.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Sandbox watchdog sweep failed", { cause })),
        Effect.repeat(Schedule.spaced(SANDBOX_WATCHDOG_INTERVAL)),
        Effect.asVoid,
      ),
    ).pipe(Effect.asVoid);

  return SandboxWatchdogService.of({
    runOnce,
    start,
  });
});

export const layer = Layer.effect(SandboxWatchdogService, make);
