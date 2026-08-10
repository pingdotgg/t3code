import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type { DesktopBackendInstance, DesktopBackendSnapshot } from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { resolveDesktopBackendPort } from "./DesktopApp.ts";

export const PACKAGED_SMOKE_FLAG = "T3CODE_DESKTOP_PACKAGED_SMOKE";
export const PACKAGED_SMOKE_RECEIPT = "T3CODE_DESKTOP_PACKAGED_SMOKE_RECEIPT";
export const PACKAGED_SMOKE_WSL_DISTRO = "T3CODE_DESKTOP_PACKAGED_SMOKE_WSL_DISTRO";

const WINDOWS_READY_TIMEOUT = Duration.seconds(45);
const WSL_READY_TIMEOUT = Duration.seconds(120);
const STOP_TIMEOUT = Duration.seconds(15);

export class DesktopPackagedSmokeConfigurationError extends Schema.TaggedErrorClass<DesktopPackagedSmokeConfigurationError>()(
  "DesktopPackagedSmokeConfigurationError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Packaged desktop smoke configuration is invalid: ${this.reason}`;
  }
}

export class DesktopPackagedSmokeBackendError extends Schema.TaggedErrorClass<DesktopPackagedSmokeBackendError>()(
  "DesktopPackagedSmokeBackendError",
  {
    backendId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Packaged desktop smoke backend ${this.backendId} failed: ${this.reason}`;
  }
}

export function isPackagedSmokeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PACKAGED_SMOKE_FLAG]?.trim() === "1";
}

function optionalSmokeValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function snapshotJson(snapshot: DesktopBackendSnapshot) {
  return {
    desiredRunning: snapshot.desiredRunning,
    ready: snapshot.ready,
    activePid: Option.getOrNull(snapshot.activePid),
    restartAttempt: snapshot.restartAttempt,
    restartScheduled: snapshot.restartScheduled,
  };
}

const describeReadyInstance = Effect.fn("desktop.packagedSmoke.describeReadyInstance")(
  function* (instance: DesktopBackendInstance, timeout: Duration.Duration) {
    const ready = yield* instance.waitForReady(timeout);
    if (!ready) {
      const snapshot = yield* instance.snapshot;
      return yield* new DesktopPackagedSmokeBackendError({
        backendId: instance.id,
        reason: `did not become HTTP-ready before timeout (snapshot=${JSON.stringify(snapshotJson(snapshot))})`,
      });
    }

    const config = yield* instance.currentConfig;
    if (Option.isNone(config)) {
      return yield* new DesktopPackagedSmokeBackendError({
        backendId: instance.id,
        reason: "became ready without a resolved backend configuration",
      });
    }
    const snapshot = yield* instance.snapshot;
    return {
      id: instance.id,
      label: yield* instance.label,
      httpBaseUrl: config.value.httpBaseUrl.href,
      executablePath: config.value.executablePath,
      entryPath: config.value.entryPath,
      cwd: config.value.cwd,
      port: config.value.bootstrap.port,
      bindHost: config.value.bootstrap.host,
      pid: Option.getOrNull(snapshot.activePid),
      runningDistro: config.value.runningDistro ?? null,
      wslNodePath: config.value.wslNodePath ?? null,
      snapshot: snapshotJson(snapshot),
    };
  },
);

function stopAll(instances: readonly DesktopBackendInstance[]) {
  return Effect.forEach(instances, (instance) => instance.stop({ timeout: STOP_TIMEOUT }), {
    concurrency: "unbounded",
  }).pipe(Effect.asVoid);
}

function writeReceipt(receiptPath: string, value: unknown) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    yield* fs.makeDirectory(environment.path.dirname(receiptPath), { recursive: true });
    const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
    yield* fs.writeFileString(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    yield* fs.rename(temporaryPath, receiptPath);
  });
}

const runSmoke = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) {
    return yield* new DesktopPackagedSmokeConfigurationError({
      reason: "the packaged smoke path may only run from an Electron packaged artifact",
    });
  }
  if (environment.platform !== "win32") {
    return yield* new DesktopPackagedSmokeConfigurationError({
      reason: `the packaged lifecycle smoke currently targets Windows, got ${environment.platform}`,
    });
  }

  const receiptPath = optionalSmokeValue(PACKAGED_SMOKE_RECEIPT);
  if (receiptPath === null) {
    return yield* new DesktopPackagedSmokeConfigurationError({
      reason: `${PACKAGED_SMOKE_RECEIPT} must name an absolute receipt path`,
    });
  }
  if (!environment.path.isAbsolute(receiptPath)) {
    return yield* new DesktopPackagedSmokeConfigurationError({
      reason: `${PACKAGED_SMOKE_RECEIPT} must be absolute: ${receiptPath}`,
    });
  }

  const electronApp = yield* ElectronApp.ElectronApp;
  const settingsService = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
  const startedAt = new Date().toISOString();
  const requestedDistro = optionalSmokeValue(PACKAGED_SMOKE_WSL_DISTRO);

  yield* electronApp.whenReady;
  yield* settingsService.load;
  yield* settingsService.setServerExposureMode("local-only");
  yield* settingsService.setWslOnly(false);

  if (requestedDistro === null) {
    yield* settingsService.setWslBackendEnabled(false);
  } else {
    yield* settingsService.setWslDistro(requestedDistro);
    yield* settingsService.setWslBackendEnabled(true);
  }

  const portSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  yield* serverExposure.configureFromSettings({ port: portSelection.port });

  const primary = yield* pool.primary;
  yield* primary.start;
  const windowsBackend = yield* describeReadyInstance(primary, WINDOWS_READY_TIMEOUT);

  let wslBackendReceipt: {
    readonly id: string;
    readonly label: string;
    readonly httpBaseUrl: string;
    readonly executablePath: string;
    readonly entryPath: string;
    readonly cwd: string;
    readonly port: number;
    readonly bindHost: string;
    readonly pid: number | null;
    readonly runningDistro: string | null;
    readonly wslNodePath: string | null;
    readonly snapshot: ReturnType<typeof snapshotJson>;
  } | null = null;
  if (requestedDistro !== null) {
    yield* wslBackend.retry;
    const targetId = DesktopBackendPool.BackendInstanceId(
      `${DesktopWslBackend.WSL_INSTANCE_ID_PREFIX}${requestedDistro}`,
    );
    const target = yield* pool.get(targetId);
    if (Option.isNone(target)) {
      const diagnostic = yield* wslBackend.lastDiagnostic;
      return yield* new DesktopPackagedSmokeBackendError({
        backendId: targetId,
        reason: Option.match(diagnostic, {
          onNone: () => "WSL orchestrator did not register the requested backend",
          onSome: (value) => value.message,
        }),
      });
    }
    wslBackendReceipt = yield* describeReadyInstance(target.value, WSL_READY_TIMEOUT);
  }

  const beforeStopInstances = yield* pool.list;
  const beforeStop = yield* Effect.forEach(beforeStopInstances, (instance) =>
    instance.snapshot.pipe(Effect.map((snapshot) => ({ id: instance.id, snapshot: snapshotJson(snapshot) }))),
  );

  yield* stopAll(beforeStopInstances);

  const afterFirstStopInstances = yield* pool.list;
  const afterFirstStop = yield* Effect.forEach(afterFirstStopInstances, (instance) =>
    instance.snapshot.pipe(Effect.map((snapshot) => ({ id: instance.id, snapshot: snapshotJson(snapshot) }))),
  );
  for (const entry of afterFirstStop) {
    if (entry.snapshot.ready || entry.snapshot.activePid !== null || entry.snapshot.desiredRunning) {
      return yield* new DesktopPackagedSmokeBackendError({
        backendId: entry.id,
        reason: `backend remained active after first shutdown: ${JSON.stringify(entry.snapshot)}`,
      });
    }
  }

  // A second cycle catches lifecycle bugs that only appear after the first
  // process tree has exited: stale ports, stale desiredRunning state, and WSL
  // retry/re-registration problems. This still uses the same packaged process.
  yield* primary.start;
  const restartedWindowsBackend = yield* describeReadyInstance(primary, WINDOWS_READY_TIMEOUT);
  let restartedWslBackend: typeof wslBackendReceipt = null;
  if (requestedDistro !== null) {
    yield* wslBackend.retry;
    const targetId = DesktopBackendPool.BackendInstanceId(
      `${DesktopWslBackend.WSL_INSTANCE_ID_PREFIX}${requestedDistro}`,
    );
    const target = yield* pool.get(targetId);
    if (Option.isNone(target)) {
      return yield* new DesktopPackagedSmokeBackendError({
        backendId: targetId,
        reason: "WSL orchestrator did not re-register the backend during packaged restart verification",
      });
    }
    restartedWslBackend = yield* describeReadyInstance(target.value, WSL_READY_TIMEOUT);
  }

  const finalStopInstances = yield* pool.list;
  yield* stopAll(finalStopInstances);
  const afterStopInstances = yield* pool.list;
  const afterStop = yield* Effect.forEach(afterStopInstances, (instance) =>
    instance.snapshot.pipe(Effect.map((snapshot) => ({ id: instance.id, snapshot: snapshotJson(snapshot) }))),
  );

  for (const entry of afterStop) {
    if (entry.snapshot.ready || entry.snapshot.activePid !== null || entry.snapshot.desiredRunning) {
      return yield* new DesktopPackagedSmokeBackendError({
        backendId: entry.id,
        reason: `backend remained active after final shutdown: ${JSON.stringify(entry.snapshot)}`,
      });
    }
  }

  const receipt = {
    schemaVersion: 1,
    status: "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    app: {
      version: environment.appVersion,
      platform: environment.platform,
      arch: environment.processArch,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      appRoot: environment.appRoot,
      stateDir: environment.stateDir,
      pid: process.pid,
    },
    portSelection: {
      port: portSelection.port,
      selectedByScan: portSelection.selectedByScan,
    },
    requestedWslDistro: requestedDistro,
    windowsBackend,
    wslBackend: wslBackendReceipt,
    beforeStop,
    afterFirstStop,
    restartCycle: {
      windowsBackend: restartedWindowsBackend,
      wslBackend: restartedWslBackend,
    },
    afterStop,
  };

  yield* writeReceipt(receiptPath, receipt);
  yield* electronApp.quit;
});

export const program = Effect.scoped(
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    yield* runSmoke.pipe(Effect.ensuring(electronApp.quit));
  }),
).pipe(
  Effect.withSpan("desktop.packagedSmoke"),
  Effect.tapErrorCause((cause) =>
    Effect.logError("packaged desktop lifecycle smoke failed").pipe(
      Effect.annotateLogs({ cause: String(cause) }),
    ),
  ),
);
