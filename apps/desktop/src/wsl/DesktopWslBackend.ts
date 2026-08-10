// Orchestrator that keeps the WSL pool instance in sync with the user's
// settings. `reconcile` is the single entry point — bootstrap calls it
// once after the primary backend starts, and the wsl.ts IPC calls it
// after persisting a `wslBackendEnabled` or `wslDistro` change. The
// effect is idempotent and never fails: errors (WSL not available, port
// allocation failed, register failed) get logged and reconcile returns
// having left the pool in a consistent state (either the previous WSL
// instance is still running, or none is).
//
// The instance id encodes the desired distro selection — `wsl:default`
// when the user picked "track the WSL default" (settings.wslDistro is
// null) and `wsl:<distro>` otherwise. Changing the distro setting
// changes the id, so reconcile unregisters the old instance before
// registering the new one. The label that the frontend env switcher
// renders is derived from the same field.
//
// Port allocation: the concrete WSL distro is the source of truth. The
// Windows host supplies only a preferred port (one above the primary); config
// resolution tests/binds that number inside Linux and can fall back to a
// kernel-selected ephemeral Linux port. Windows-side socket availability is
// intentionally not consulted because it is the wrong namespace for a
// Linux-owned listener.

import * as Cause from "effect/Cause";
import type { DesktopWslDiagnosticRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslDiagnostics from "./DesktopWslDiagnostics.ts";

// Exported so callers that parse pool ids (e.g. the pickFolder IPC
// handler in ipc/methods/window.ts) reference the same prefix this
// module produces. Keeping it inline in two places risks silent
// divergence if one ever gets renamed.
export const WSL_INSTANCE_ID_PREFIX = "wsl:";
const WSL_DEFAULT_DISTRO_ID = `${WSL_INSTANCE_ID_PREFIX}default`;

export class DesktopWslBackend extends Context.Service<
  DesktopWslBackend,
  {
    // Bring the pool in line with the current persisted WSL settings.
    // Idempotent. Never fails (errors are logged); callers can chain it
    // after persisting settings without an error-handling dance.
    readonly reconcile: Effect.Effect<void>;
    // Reason the dual-mode WSL secondary last failed preflight (no node, wrong
    // version, missing build tools), or None. Read by the getWslState IPC so
    // Connections settings can show it inline. None in wsl-only mode (that path
    // surfaces via a dialog + Windows fallback).
    readonly lastPreflightError: Effect.Effect<Option.Option<string>>;
    readonly lastDiagnostic: Effect.Effect<Option.Option<DesktopWslDiagnosticRecord>>;
    readonly retry: Effect.Effect<void>;
  }
>()("@t3tools/desktop/wsl/DesktopWslBackend") {}

const { logInfo: logWslBackendInfo, logWarning: logWslBackendWarning } =
  DesktopObservability.makeComponentLogger("desktop-wsl-backend");

const resolveTargetInstanceId = (distro: string | null): DesktopBackendPool.BackendInstanceId =>
  DesktopBackendPool.BackendInstanceId(
    distro === null ? WSL_DEFAULT_DISTRO_ID : `${WSL_INSTANCE_ID_PREFIX}${distro}`,
  );

const isWslInstanceId = (id: DesktopBackendPool.BackendInstanceId): boolean =>
  id.startsWith(WSL_INSTANCE_ID_PREFIX);

const buildLabel = (distro: string | null): string =>
  distro === null ? "WSL (default distro)" : `WSL (${distro})`;

export const layer = Layer.effect(
  DesktopWslBackend,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const diagnostics = yield* DesktopWslDiagnostics.DesktopWslDiagnostics;
    // Serialize reconcile so the bootstrap fork and the IPC handlers
    // (setWslBackendEnabled, setWslDistro) can't interleave. Without
    // this, two reconciles could both observe "no WSL instance
    // registered" between their pool reads and both call startNew
    // with different distros, leaving the loser stranded.
    const reconcileMutex = yield* Semaphore.make(1);

    // Last fatal preflight failure from the dual-mode WSL *secondary*, surfaced
    // inline in Connections settings. The primary's failure is handled by the
    // pool (dialog + Windows fallback) instead; here the app stays usable on
    // Windows, so we record the reason rather than interrupting. Cleared on any
    // reconcile state change so it reflects the current attempt.
    const preflightErrorRef = yield* Ref.make(Option.none<string>());

    const recordDiagnostic = Effect.fn("desktop.wslBackend.recordDiagnostic")(function* (input: {
      readonly phase: "preflight" | "spawn" | "readiness" | "runtime-exit" | "configuration";
      readonly message: string;
      readonly distro: string | null;
      readonly config?: DesktopBackendStartConfig;
      readonly pid?: number | null;
      readonly restartAttempt?: number | null;
    }) {
      const distros = yield* wslEnvironment.probeDistros.pipe(Effect.orElseSucceed(() => []));
      const effectiveDistro = input.config?.runningDistro ?? input.distro;
      const distroRecord = effectiveDistro
        ? distros.find((candidate) => candidate.name.toLowerCase() === effectiveDistro.toLowerCase())
        : distros.find((candidate) => candidate.isDefault);
      yield* diagnostics.record({
        phase: input.phase,
        message: input.message,
        distro: effectiveDistro ?? distroRecord?.name ?? null,
        wslVersion: distroRecord?.version ?? null,
        nodePath: input.config?.wslNodePath ?? null,
        httpBaseUrl: input.config?.httpBaseUrl.href ?? null,
        bindHost: input.config?.bootstrap.host ?? null,
        port: input.config?.bootstrap.port ?? null,
        restartAttempt: input.restartAttempt ?? null,
        pid: input.pid ?? null,
      });
    });

    const findExistingWslInstance = pool.list.pipe(
      Effect.map((instances) => instances.find((instance) => isWslInstanceId(instance.id))),
      Effect.map(Option.fromNullishOr),
    );

    const stopExisting = (id: DesktopBackendPool.BackendInstanceId) =>
      pool.unregister(id).pipe(
        Effect.catchTags({
          DesktopBackendPoolCannotUnregisterPrimaryError: (cause) =>
            // Should never happen — wsl: ids are not the primary id — but
            // log loudly if the logic ever drifts.
            logWslBackendWarning("refusing to unregister primary as wsl instance", {
              id,
              error: cause.message,
            }),
        }),
      );

    const startNew = Effect.fn("desktop.wslBackend.startNew")(function* (input: {
      readonly distro: string | null;
    }) {
      const primaryConfig = yield* serverExposure.backendConfig;
      // Keep the historical "primary + 1" as a stable preference, but the
      // actual availability decision now happens inside the selected distro.
      // If the preferred number is occupied in Linux, resolveWsl may choose an
      // ephemeral Linux port instead. Clamp 65536 back into the valid range;
      // the WSL-side allocator will fall back if 65535 is already occupied.
      const preferredPort = Math.min(primaryConfig.port + 1, 65_535);

      const targetId = resolveTargetInstanceId(input.distro);
      yield* logWslBackendInfo("registering WSL backend with pool", {
        id: targetId,
        preferredPort,
        distro: input.distro ?? null,
      });

      const instance = yield* pool
        .register({
          id: targetId,
          label: Effect.succeed(buildLabel(input.distro)),
          configResolve: configuration.resolveWsl({
            port: preferredPort,
            distro: input.distro,
            portStrategy: "wsl-auto",
          }),
          // Dual-mode secondary: record a fatal preflight failure so Connections
          // settings can show why the WSL backend never appeared. No dialog or
          // fallback — Windows is the primary and keeps working.
          onPreflightFailed: (failure) =>
            Ref.set(preflightErrorRef, Option.some(failure.reason)).pipe(
              Effect.andThen(
                recordDiagnostic({
                  phase: "preflight",
                  message: failure.reason,
                  distro: input.distro,
                }),
              ),
              Effect.as(false),
            ),
          onFailure: (failure) =>
            recordDiagnostic({
              phase: failure.phase,
              message: failure.reason,
              distro: input.distro,
              config: failure.config,
              pid: failure.pid,
              restartAttempt: failure.restartAttempt,
            }),
          onReady: () =>
            Ref.set(preflightErrorRef, Option.none()).pipe(Effect.andThen(diagnostics.clear)),
        })
        .pipe(
          Effect.map((registered) => Option.some(registered)),
          Effect.catch((error) =>
            logWslBackendWarning("WSL backend already registered, skipping start", {
              id: targetId,
              error: error.message,
            }).pipe(Effect.as(Option.none<DesktopBackendPool.DesktopBackendInstance>())),
          ),
        );

      yield* Option.match(instance, {
        onNone: () => Effect.void,
        onSome: (registered) => registered.start,
      });
    });

    const reconcileBody = Effect.gen(function* () {
      const settings = yield* appSettings.get;
      const available = yield* wslEnvironment.isAvailable;
      const existing = yield* findExistingWslInstance;
      const existingId = Option.map(existing, (instance) => instance.id);

      // In wsl-only mode the pool's primary IS the WSL backend (see
      // DesktopBackendConfiguration.resolvePrimary), so the
      // orchestrator skips registering a parallel "wsl:<distro>"
      // secondary. Without this skip we'd spin up two WSL processes
      // on the same distro for users who explicitly asked for one.
      const shouldRun = settings.wslBackendEnabled && available && !settings.wslOnly;
      const targetId = shouldRun
        ? Option.some(resolveTargetInstanceId(settings.wslDistro))
        : Option.none<DesktopBackendPool.BackendInstanceId>();

      // No-op if the desired state already matches what's registered.
      if (Option.isNone(targetId) && Option.isNone(existingId)) {
        return;
      }
      if (
        Option.isSome(targetId) &&
        Option.isSome(existing) &&
        targetId.value === existing.value.id
      ) {
        const existingInstance = existing.value;
        const snapshot = yield* existingInstance.snapshot;
        const isIdle =
          !snapshot.ready && Option.isNone(snapshot.activePid) && !snapshot.restartScheduled;
        if (isIdle) {
          yield* logWslBackendInfo("retrying idle WSL backend", { id: existingInstance.id });
          yield* Ref.set(preflightErrorRef, Option.none());
          yield* existingInstance.start;
        }
        return;
      }

      // A real state change is happening (start, stop, or distro swap). Clear
      // any stale secondary preflight error so it reflects this fresh attempt;
      // onPreflightFailed re-sets it only if the new secondary exhausts retries.
      yield* Ref.set(preflightErrorRef, Option.none());
      yield* diagnostics.clear;

      if (Option.isSome(existingId)) {
        yield* logWslBackendInfo("tearing down WSL backend", { id: existingId.value });
        yield* stopExisting(existingId.value);
      }

      if (Option.isSome(targetId)) {
        // Pre-warm the WSL VM before registering so the readiness probe
        // doesn't race wsl.exe's first-spawn cold start. preWarm tolerates
        // distro=null (uses the WSL default) and is bounded by its own
        // timeout, so it's safe to await unconditionally here.
        yield* wslEnvironment.preWarm(settings.wslDistro);
        yield* startNew({ distro: settings.wslDistro });
      }
    });

    // Top-level safety net. Every internal step today already catches
    // its own failures (port allocation, register, preWarm), so the
    // inferred error type is `never` and this catch is a no-op in
    // steady state. It's here to enforce the file-header contract
    // ("reconcile never fails; errors are logged") if a future change
    // introduces an unhandled failure path — otherwise IPC callers
    // like setWslBackendEnabled would surface it to the renderer as
    // an opaque error.
    const reconcile = reconcileMutex
      .withPermits(1)(reconcileBody)
      .pipe(
        Effect.catchCause((cause) =>
          logWslBackendWarning("reconcile failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.withSpan("desktop.wslBackend.reconcile"),
      );

    const retry = reconcileMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(preflightErrorRef, Option.none());
        yield* diagnostics.clear;
        const existing = yield* findExistingWslInstance;
        if (Option.isSome(existing)) {
          yield* stopExisting(existing.value.id);
        }
        yield* reconcileBody;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        logWslBackendWarning("explicit WSL retry failed", { cause: Cause.pretty(cause) }),
      ),
    );

    return DesktopWslBackend.of({
      reconcile,
      retry,
      lastPreflightError: Ref.get(preflightErrorRef),
      lastDiagnostic: diagnostics.current,
    });
  }),
);
