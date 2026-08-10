import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";

const RESUME_SETTLE_DELAY = Duration.seconds(2);
const BACKEND_PROBE_TIMEOUT = Duration.seconds(2);
const BACKEND_STOP_TIMEOUT = Duration.seconds(6);
const BACKEND_RESTART_READY_TIMEOUT = Duration.seconds(20);

const { logInfo: logRecoveryInfo, logWarning: logRecoveryWarning } =
  makeComponentLogger("desktop-power-recovery");

export type DesktopPowerRecoveryRuntimeServices =
  | DesktopBackendPool.DesktopBackendPool
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopWslBackend.DesktopWslBackend
  | ElectronPowerMonitor.ElectronPowerMonitor;

export class DesktopPowerRecovery extends Context.Service<
  DesktopPowerRecovery,
  {
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopPowerRecoveryRuntimeServices
    >;
  }
>()("@t3tools/desktop/app/DesktopPowerRecovery") {}

export const reconcileInstanceAfterResume = Effect.fn("desktop.powerRecovery.reconcileInstance")(
  function* (instance: DesktopBackendManager.DesktopBackendInstance) {
    const before = yield* instance.snapshot;
    if (!before.desiredRunning) return;

    const healthy = before.ready
      ? yield* instance.probeReady(BACKEND_PROBE_TIMEOUT)
      : false;
    if (healthy) {
      yield* logRecoveryInfo("backend remained healthy after resume", { id: instance.id });
      return;
    }

    yield* logRecoveryWarning("backend unhealthy after resume; restarting", {
      id: instance.id,
      readyBeforeProbe: before.ready,
      pid: Option.getOrNull(before.activePid),
      restartScheduled: before.restartScheduled,
    });

    yield* instance.stop({ timeout: BACKEND_STOP_TIMEOUT });
    yield* instance.start;
    const ready = yield* instance.waitForReady(BACKEND_RESTART_READY_TIMEOUT);
    if (ready) {
      yield* logRecoveryInfo("backend recovered after resume", { id: instance.id });
      return;
    }

    yield* logRecoveryWarning("backend did not recover inside resume window", {
      id: instance.id,
      timeoutMs: Duration.toMillis(BACKEND_RESTART_READY_TIMEOUT),
    });
  },
);

export const make = DesktopPowerRecovery.of({
  register: Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "win32") return;

    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
    const state = yield* DesktopState.DesktopState;
    const scope = yield* Scope.Scope;
    const generationRef = yield* Ref.make(0);
    const recoveryMutex = yield* Semaphore.make(1);
    const context = yield* Effect.context<DesktopPowerRecoveryRuntimeServices>();
    const runEffect = Effect.runPromiseWith(context);

    const invalidatePendingRecovery = Ref.update(generationRef, (generation) => generation + 1);

    const recoverAfterResume = Effect.gen(function* () {
      const generation = yield* Ref.updateAndGet(generationRef, (current) => current + 1);
      yield* logRecoveryInfo("Windows resume observed; scheduling backend health reconciliation", {
        generation,
        settleDelayMs: Duration.toMillis(RESUME_SETTLE_DELAY),
      });
      yield* Effect.sleep(RESUME_SETTLE_DELAY);
      yield* recoveryMutex.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(generationRef)) !== generation) return;
          if (yield* Ref.get(state.quitting)) return;

          const instances = yield* pool.list;
          yield* Effect.forEach(instances, reconcileInstanceAfterResume, {
            concurrency: 1,
            discard: true,
          });

          // A WSL secondary may have disappeared entirely while Windows slept.
          // Reconcile after existing instances are probed/restarted so the normal
          // orchestrator can recreate a missing secondary and re-resolve its distro
          // address with the current WSL network state.
          yield* wslBackend.reconcile;
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        logRecoveryWarning("resume recovery failed", { cause: String(cause) }),
      ),
      Effect.withSpan("desktop.powerRecovery.resume"),
    );

    const launchScoped = (effect: Effect.Effect<void>) => {
      void runEffect(Effect.forkIn(effect, scope).pipe(Effect.asVoid));
    };

    yield* powerMonitor.onSimpleEvent("suspend", () => {
      launchScoped(
        invalidatePendingRecovery.pipe(
          Effect.andThen(logRecoveryInfo("Windows suspend observed")),
          Effect.withSpan("desktop.powerRecovery.suspend"),
        ),
      );
    });
    yield* powerMonitor.onSimpleEvent("resume", () => {
      launchScoped(recoverAfterResume);
    });
  }),
});

export const layer = Layer.succeed(DesktopPowerRecovery, make);
