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
// Port allocation: each WSL instance gets a freshly scanned port to
// avoid colliding with the primary or with a previously-registered WSL
// instance that's still tearing down. The scan only checks loopback
// (127.0.0.1) since the WSL backend is loopback-only — the primary
// owns LAN exposure when the user opts in.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as NetService from "@t3tools/shared/Net";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";

const WSL_INSTANCE_ID_PREFIX = "wsl:";
const WSL_DEFAULT_DISTRO_ID = `${WSL_INSTANCE_ID_PREFIX}default`;
const MAX_TCP_PORT = 65_535;

export interface DesktopWslBackendShape {
  // Bring the pool in line with the current persisted WSL settings.
  // Idempotent. Never fails (errors are logged); callers can chain it
  // after persisting settings without an error-handling dance.
  readonly reconcile: Effect.Effect<void>;
}

export class DesktopWslBackend extends Context.Service<DesktopWslBackend, DesktopWslBackendShape>()(
  "t3/desktop/WslBackend",
) {}

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

// Loopback-only port scan starting one above the primary's port. The
// WSL backend is reachable via 127.0.0.1 from Windows (wslhost
// auto-forwards), so we only need to verify the IPv4 loopback can bind.
const scanForWslPort = Effect.fn("desktop.wslBackend.scanForWslPort")(function* (
  startPort: number,
): Effect.fn.Return<number, NetService.NetError, NetService.NetService> {
  const net = yield* NetService.NetService;
  for (let port = startPort; port <= MAX_TCP_PORT; port += 1) {
    if (yield* net.canListenOnHost(port, "127.0.0.1")) {
      return port;
    }
  }
  return yield* new NetService.NetError({
    message: `No loopback port available for WSL backend between ${startPort} and ${MAX_TCP_PORT}.`,
  });
});

export const layer = Layer.effect(
  DesktopWslBackend,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const net = yield* NetService.NetService;
    // Serialize reconcile so the bootstrap fork and the IPC handlers
    // (setWslBackendEnabled, setWslDistro) can't interleave. Without
    // this, two reconciles could both observe "no WSL instance
    // registered" between their pool reads and both call startNew
    // with different distros, leaving the loser stranded.
    const reconcileMutex = yield* Semaphore.make(1);

    const findExistingWslInstance = pool.list.pipe(
      Effect.map((instances) => instances.find((instance) => isWslInstanceId(instance.id))),
      Effect.map(Option.fromNullishOr),
    );

    const stopExisting = (id: DesktopBackendPool.BackendInstanceId) =>
      pool.unregister(id).pipe(
        Effect.catchTag("DesktopBackendPoolCannotUnregisterPrimaryError", (cause) =>
          // Should never happen — wsl: ids are not the primary id — but
          // log loudly if the logic ever drifts.
          logWslBackendWarning("refusing to unregister primary as wsl instance", {
            id,
            error: cause.message,
          }),
        ),
      );

    const startNew = Effect.fn("desktop.wslBackend.startNew")(function* (input: {
      readonly distro: string | null;
    }) {
      const primaryConfig = yield* serverExposure.backendConfig;
      const port = yield* scanForWslPort(primaryConfig.port + 1).pipe(
        Effect.provideService(NetService.NetService, net),
        Effect.map((value) => Option.some(value)),
        Effect.catch((error) =>
          logWslBackendWarning("could not allocate port for WSL backend", {
            error: error.message,
          }).pipe(Effect.as(Option.none<number>())),
        ),
      );

      if (Option.isNone(port)) {
        return;
      }
      const allocatedPort = port.value;

      const targetId = resolveTargetInstanceId(input.distro);
      yield* logWslBackendInfo("registering WSL backend with pool", {
        id: targetId,
        port: allocatedPort,
        distro: input.distro ?? null,
      });

      const instance = yield* pool
        .register({
          id: targetId,
          label: buildLabel(input.distro),
          configResolve: configuration.resolveWsl({ port: allocatedPort, distro: input.distro }),
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
        Option.isSome(existingId) &&
        targetId.value === existingId.value
      ) {
        return;
      }

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

    const reconcile = reconcileMutex
      .withPermits(1)(reconcileBody)
      .pipe(Effect.withSpan("desktop.wslBackend.reconcile"));

    return DesktopWslBackend.of({ reconcile });
  }),
);
