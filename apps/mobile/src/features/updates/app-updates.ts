import * as Updates from "expo-updates";

import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

export type AppUpdateCheckState =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "restarting"
  | "current";

export interface AppUpdateClient {
  readonly isEnabled: boolean;
  readonly checkForUpdateAsync: () => Promise<{
    readonly isAvailable: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly fetchUpdateAsync: () => Promise<{
    readonly isNew: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly reloadAsync: () => Promise<void>;
}

/**
 * The pieces of the app the update flow has to coordinate with before it may
 * tear down the JavaScript runtime. Injectable so the flow stays unit-testable.
 */
export interface AppUpdateEnvironment {
  /** Asks the user to install the downloaded update now; `false` defers it. */
  readonly confirmInstallNow: () => Promise<boolean>;
  /** Lands best-effort persisted state (drafts, outbox) before the restart. */
  readonly flushPendingWrites: () => Promise<void>;
  /** Runs `apply` the next time the app leaves the foreground. */
  readonly onNextBackground: (apply: () => void) => void;
}

/** Tracks a downloaded update waiting for a safe moment to install. */
export interface AppUpdateDeferral {
  pendingInstall: boolean;
}

export function createAppUpdateDeferral(): AppUpdateDeferral {
  return { pendingInstall: false };
}

const appUpdateDeferral = createAppUpdateDeferral();

interface AppUpdateCheckOptions {
  /**
   * "prompt" (default) asks before restarting and defers a declined install to
   * the next backgrounding. "immediate" restarts as soon as the download
   * lands — reserved for flows where the user explicitly requested the update.
   */
  readonly applyMode?: "immediate" | "prompt";
  readonly client?: AppUpdateClient;
  readonly deferral?: AppUpdateDeferral;
  readonly environment?: AppUpdateEnvironment;
  readonly onFailure?: (message: string) => void;
  readonly onStateChange?: (state: AppUpdateCheckState) => void;
}

interface AppUpdateCheckProgress {
  failure: string | undefined;
  state: AppUpdateCheckState | undefined;
}

interface AppUpdateCheckInFlight {
  readonly failureListeners: Set<NonNullable<AppUpdateCheckOptions["onFailure"]>>;
  readonly progress: AppUpdateCheckProgress;
  readonly promise: Promise<void>;
  readonly stateListeners: Set<NonNullable<AppUpdateCheckOptions["onStateChange"]>>;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (cause: unknown) => void;
  readonly resolve: () => void;
}

const HIDDEN_UPDATE_TAP_COUNT = 5;
const UPDATE_CHECK_UNAVAILABLE_ERROR_CODES = new Set([
  "ERR_NOT_AVAILABLE_IN_DEV_CLIENT",
  "ERR_UPDATES_DISABLED",
]);
let appUpdateCheckInFlight: AppUpdateCheckInFlight | undefined;

/** Expo's development launcher reports updates as enabled even though its OTA APIs reject. */
export function isAppUpdateCheckAvailable(client: Pick<AppUpdateClient, "isEnabled"> = Updates) {
  return client.isEnabled && !(typeof __DEV__ !== "undefined" && __DEV__);
}

/**
 * Keeps the manual update affordance discoverable only to someone deliberately
 * tapping the version row five times.
 */
export function registerHiddenUpdateTap(count: number): {
  readonly nextCount: number;
  readonly shouldCheck: boolean;
} {
  const nextCount = count + 1;
  if (nextCount >= HIDDEN_UPDATE_TAP_COUNT) {
    return {
      nextCount: 0,
      shouldCheck: true,
    };
  }
  return {
    nextCount,
    shouldCheck: false,
  };
}

export async function runAppUpdateCheck(options: AppUpdateCheckOptions = {}): Promise<void> {
  const client = options.client ?? Updates;
  if (!isAppUpdateCheckAvailable(client)) return;

  if (appUpdateCheckInFlight) {
    await observeAppUpdateCheck(appUpdateCheckInFlight, options);
    return;
  }

  const progress: AppUpdateCheckProgress = {
    failure: undefined,
    state: undefined,
  };
  const failureListeners = new Set<NonNullable<AppUpdateCheckOptions["onFailure"]>>();
  const stateListeners = new Set<NonNullable<AppUpdateCheckOptions["onStateChange"]>>();
  if (options.onFailure) failureListeners.add(options.onFailure);
  if (options.onStateChange) stateListeners.add(options.onStateChange);

  const deferred = createDeferred();
  const inFlight: AppUpdateCheckInFlight = {
    failureListeners,
    progress,
    promise: deferred.promise,
    stateListeners,
  };
  // Publish the operation before any state listener can synchronously re-enter.
  appUpdateCheckInFlight = inFlight;

  const execution = performAppUpdateCheck(client, {
    applyMode: options.applyMode,
    deferral: options.deferral,
    environment: options.environment,
    onFailure: (message) => {
      progress.failure = message;
      notifyListeners(failureListeners, message);
    },
    onStateChange: (state) => {
      progress.state = state;
      notifyListeners(stateListeners, state);
    },
  });
  void execution.then(deferred.resolve, deferred.reject);

  try {
    await deferred.promise;
  } finally {
    if (appUpdateCheckInFlight === inFlight) {
      appUpdateCheckInFlight = undefined;
    }
  }
}

function createDeferred(): Deferred {
  let reject!: Deferred["reject"];
  let resolve!: Deferred["resolve"];
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function notifyListeners<A>(listeners: ReadonlySet<(value: A) => void>, value: A): void {
  // A listener can synchronously subscribe another caller. Snapshot so that
  // caller receives only observeAppUpdateCheck's explicit current-value replay.
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) listener(value);
}

async function observeAppUpdateCheck(
  inFlight: AppUpdateCheckInFlight,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const onFailure = options.onFailure;
  const onStateChange = options.onStateChange;

  if (onFailure) {
    inFlight.failureListeners.add(onFailure);
    if (inFlight.progress.failure) onFailure(inFlight.progress.failure);
  }
  if (onStateChange) {
    inFlight.stateListeners.add(onStateChange);
    if (inFlight.progress.state) onStateChange(inFlight.progress.state);
  }

  try {
    await inFlight.promise;
  } finally {
    if (onFailure) inFlight.failureListeners.delete(onFailure);
    if (onStateChange) inFlight.stateListeners.delete(onStateChange);
  }
}

async function performAppUpdateCheck(
  client: AppUpdateClient,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const setState = options.onStateChange ?? (() => {});
  const environment = options.environment ?? defaultAppUpdateEnvironment;
  const deferral = options.deferral ?? appUpdateDeferral;

  setState("checking");
  const check = await settlePromise(() => client.checkForUpdateAsync());
  if (check._tag === "Failure") {
    reportUpdateFailure(check, "Could not check for updates.", options.onFailure);
    setState("idle");
    return;
  }
  // A rollback directive (`eas update:rollback`) arrives as isAvailable: false
  // with isRollBackToEmbedded: true. The running OTA still has to be dropped.
  if (!check.value.isAvailable && !check.value.isRollBackToEmbedded) {
    setState("current");
    return;
  }

  setState("downloading");
  const fetched = await settlePromise(() => client.fetchUpdateAsync());
  if (fetched._tag === "Failure") {
    reportUpdateFailure(fetched, "Could not download the update.", options.onFailure);
    setState("idle");
    return;
  }
  // isNew is always false for a rollback, so it cannot be the sole gate.
  if (!fetched.value.isNew && !fetched.value.isRollBackToEmbedded) {
    setState("current");
    return;
  }

  if (options.applyMode === "immediate") {
    await installAppUpdate(client, environment, options);
    return;
  }

  setState("ready");
  const installNow = await settlePromise(() => environment.confirmInstallNow());
  if (installNow._tag === "Success" && installNow.value) {
    await installAppUpdate(client, environment, options);
    return;
  }
  armDeferredAppUpdateInstall(client, environment, deferral);
}

/**
 * Restarting mid-session while native surfaces are mounted is the crashiest
 * moment expo-updates has, so the restart flushes persistence first and, when
 * declined, waits for a backgrounding — where nothing is rendering and the
 * teardown is invisible.
 */
async function installAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const setState = options.onStateChange ?? (() => {});
  setState("restarting");
  // Best-effort: a failed flush must not block the restart.
  await settlePromise(() => environment.flushPendingWrites());
  const reloaded = await settlePromise(() => client.reloadAsync());
  if (reloaded._tag === "Failure") {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.", options.onFailure);
    setState("idle");
  }
}

function armDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): void {
  if (deferral.pendingInstall) return;
  deferral.pendingInstall = true;
  environment.onNextBackground(() => {
    // One-shot: if the reload fails, the downloaded update still applies at
    // the next cold start.
    void installAppUpdate(client, environment, {});
  });
}

async function defaultConfirmInstallNow(): Promise<boolean> {
  const { Alert } = await import("react-native");
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Update ready",
      "A new version has been downloaded. Install it now, or it will be installed automatically the next time you leave the app.",
      [
        { onPress: () => resolve(false), style: "cancel", text: "Later" },
        { onPress: () => resolve(true), text: "Install Now" },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

async function defaultFlushPendingWrites(): Promise<void> {
  await Promise.allSettled([
    import("../../state/use-composer-drafts").then((drafts) => drafts.flushComposerDrafts()),
    import("../../state/thread-outbox-storage").then((outbox) => outbox.flushThreadOutboxWrites()),
  ]);
}

function defaultOnNextBackground(apply: () => void): void {
  void import("react-native").then(({ AppState }) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      subscription.remove();
      apply();
    });
  });
}

const defaultAppUpdateEnvironment: AppUpdateEnvironment = {
  confirmInstallNow: defaultConfirmInstallNow,
  flushPendingWrites: defaultFlushPendingWrites,
  onNextBackground: defaultOnNextBackground,
};

function reportUpdateFailure(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
  onFailure: AppUpdateCheckOptions["onFailure"],
): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  if (isAppUpdateUnavailableError(error)) return;

  reportAtomCommandResult(result, { label: "app update check" });
  onFailure?.(error instanceof Error ? error.message : fallback);
}

function isAppUpdateUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && UPDATE_CHECK_UNAVAILABLE_ERROR_CODES.has(code);
}

export function createAppUpdateLaunchCheck(
  client: AppUpdateClient = Updates,
): () => Promise<void> | undefined {
  let started = false;

  return () => {
    if (started || !isAppUpdateCheckAvailable(client)) return undefined;
    started = true;
    return runAppUpdateCheck({ client });
  };
}

export const checkForAppUpdateOnLaunch = createAppUpdateLaunchCheck();

/**
 * The app can stay resident for days, so a launch-only check misses updates
 * published while it was in memory. Anything shorter reads as noise: brief
 * app switches should not trigger network checks or an install prompt.
 */
export const FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS = 15 * 60 * 1000;

export function shouldRecheckAppUpdateOnForeground(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  pendingInstall: boolean,
): boolean {
  if (pendingInstall) return false;
  return (
    backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS
  );
}

export function createAppUpdateForegroundRecheck(
  client: AppUpdateClient = Updates,
  deferral: AppUpdateDeferral = appUpdateDeferral,
): () => void {
  let started = false;

  return () => {
    if (started || !isAppUpdateCheckAvailable(client)) return;
    started = true;
    void import("react-native").then(({ AppState }) => {
      let backgroundedAtMs: number | null = null;
      AppState.addEventListener("change", (state) => {
        if (state === "background") {
          backgroundedAtMs = Date.now();
          return;
        }
        if (state !== "active") return;
        const shouldCheck = shouldRecheckAppUpdateOnForeground(
          backgroundedAtMs,
          Date.now(),
          deferral.pendingInstall,
        );
        backgroundedAtMs = null;
        if (shouldCheck) void runAppUpdateCheck({ client, deferral });
      });
    });
  };
}

export const startAppUpdateForegroundRecheck = createAppUpdateForegroundRecheck();
