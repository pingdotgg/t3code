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
  /** Asks the user to install the waiting update now; `false` keeps it deferred. */
  readonly confirmInstallNow: () => Promise<boolean>;
  /**
   * Lands persisted state (drafts, outbox) before the restart. Rejects when a
   * write failed, so a silent restart can hold off instead of dropping the
   * unsaved in-memory state.
   */
  readonly flushPendingWrites: () => Promise<void>;
  /**
   * Whether a deferred restart may fire right now: the app must still be
   * backgrounded (flush latency or an iOS suspend can push the continuation
   * into the next foreground session) and not merely paused behind an
   * app-initiated handoff like the Android image picker.
   */
  readonly isSafeToRestartInBackground: () => Promise<boolean>;
  /**
   * Runs `apply` the next time the app enters the background. With
   * `includeCurrent`, an app that is already backgrounded fires immediately
   * (so a backgrounding that raced module load is not missed); without it,
   * only a future transition fires, so an attempt that already failed in the
   * current background session cannot retry in a tight loop.
   */
  readonly onNextBackground: (apply: () => void, includeCurrent: boolean) => void;
  /**
   * Runs `apply` once the app has stayed foregrounded for the whole prompt
   * window — the signal that a deferred install has had no backgrounding to
   * ride on.
   */
  readonly onForegroundStay: (apply: () => void) => void;
}

/** Tracks a downloaded update waiting for a safe moment to install. */
export interface AppUpdateDeferral {
  pendingInstall: boolean;
  /**
   * Claimed by whichever restart sequence (deferred backgrounding, foreground
   * prompt, manual install) starts first, so racing paths cannot tear down
   * the runtime twice.
   */
  installInProgress: boolean;
}

export function createAppUpdateDeferral(): AppUpdateDeferral {
  return { pendingInstall: false, installInProgress: false };
}

const appUpdateDeferral = createAppUpdateDeferral();

interface AppUpdateCheckOptions {
  /**
   * "background" (default) installs silently at the next backgrounding,
   * asking only if the app then stays foregrounded so long that the install
   * never gets its chance. "immediate" restarts as soon as the download
   * lands — reserved for flows where the user explicitly requested the update.
   */
  readonly applyMode?: "background" | "immediate";
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
    // A background-mode check in flight may have deferred the download this
    // caller explicitly asked to install; honor the explicit request now.
    if (options.applyMode === "immediate") {
      const deferral = options.deferral ?? appUpdateDeferral;
      if (deferral.pendingInstall) {
        const environment = options.environment ?? defaultAppUpdateEnvironment;
        await installPendingAppUpdate(client, environment, deferral, options);
      }
    }
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

  // The user explicitly asked to install and a previous check has already
  // downloaded the update; restart into it without another network round trip.
  if (options.applyMode === "immediate" && deferral.pendingInstall) {
    await installPendingAppUpdate(client, environment, deferral, options);
    return;
  }

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

  // A rollback directive exists to pull a broken bundle; never hold it
  // behind a prompt or a deferred install.
  if (options.applyMode === "immediate" || fetched.value.isRollBackToEmbedded) {
    const outcome = await installAppUpdate(
      client,
      environment,
      deferral,
      options,
      options.applyMode === "immediate",
    );
    if (outcome === "flush-failed") {
      // Only reachable for an automatic rollback: keep the state-bearing
      // runtime alive and retry like a deferred install. The fetched rollback
      // still applies at the next cold start regardless.
      setState("ready");
      armDeferredAppUpdateInstall(client, environment, deferral);
    }
    return;
  }

  setState("ready");
  armDeferredAppUpdateInstall(client, environment, deferral);
}

type AppUpdateInstallOutcome = "installed" | "flush-failed" | "restart-failed";

/**
 * Restarting mid-session while native surfaces are mounted is the crashiest
 * moment expo-updates has, so the restart flushes persistence first and, by
 * default, waits for a backgrounding — where nothing is rendering and the
 * teardown is invisible. Only a restart the user explicitly asked for may
 * proceed over a failed flush; an automatic one aborts with "flush-failed"
 * so unsaved state is never silently discarded.
 */
async function installAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  options: AppUpdateCheckOptions,
  userRequested: boolean,
): Promise<AppUpdateInstallOutcome> {
  // A concurrent install sequence already owns the restart.
  if (deferral.installInProgress) return "installed";
  deferral.installInProgress = true;
  const setState = options.onStateChange ?? (() => {});
  setState("restarting");
  const flushed = await settlePromise(() => environment.flushPendingWrites());
  if (flushed._tag === "Failure") {
    reportUpdateFailure(flushed, "Could not save pending state.", undefined);
    if (!userRequested) {
      deferral.installInProgress = false;
      return "flush-failed";
    }
  }
  const reloaded = await settlePromise(() => client.reloadAsync());
  if (reloaded._tag === "Failure") {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.", options.onFailure);
    setState("idle");
    deferral.installInProgress = false;
    return "restart-failed";
  }
  return "installed";
}

/** Restarts into an already-downloaded update at the user's request. */
async function installPendingAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const outcome = await installAppUpdate(client, environment, deferral, options, true);
  if (outcome === "restart-failed") {
    // Let later checks re-arm the install; the downloaded update still
    // applies at the next cold start regardless.
    deferral.pendingInstall = false;
  }
}

function armDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): void {
  if (deferral.pendingInstall) return;
  deferral.pendingInstall = true;
  scheduleDeferredAppUpdateInstall(client, environment, deferral, true);
  environment.onForegroundStay(() => {
    void promptDeferredAppUpdateInstall(client, environment, deferral);
  });
}

/**
 * A deferred install normally rides the next backgrounding, but a session that
 * never leaves the foreground would sit on the download forever. Only then is
 * the user asked, and declining simply leaves the background install armed.
 */
async function promptDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): Promise<void> {
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  const installNow = await settlePromise(() => environment.confirmInstallNow());
  if (installNow._tag !== "Success" || !installNow.value) return;
  // A backgrounding while the alert was up may have started the deferred
  // restart already; the stale accept must not start a second one.
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  await installPendingAppUpdate(client, environment, deferral, {});
}

function scheduleDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  includeCurrent: boolean,
): void {
  environment.onNextBackground(() => {
    void applyDeferredAppUpdateInstall(client, environment, deferral);
  }, includeCurrent);
}

async function applyDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): Promise<void> {
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  deferral.installInProgress = true;
  const flushed = await settlePromise(() => environment.flushPendingWrites());
  const safe = await settlePromise(() => environment.isSafeToRestartInBackground());
  if (flushed._tag === "Failure" || safe._tag !== "Success" || !safe.value) {
    if (flushed._tag === "Failure") {
      // Nothing is lost yet: keep the state-bearing runtime alive and retry
      // the flush at the next backgrounding instead of restarting over it.
      reportUpdateFailure(flushed, "Could not save pending state.", undefined);
    }
    deferral.installInProgress = false;
    // This attempt already ran in the current background session; retrying
    // before a fresh transition would just loop over the same failure.
    scheduleDeferredAppUpdateInstall(client, environment, deferral, false);
    return;
  }
  const reloaded = await settlePromise(() => client.reloadAsync());
  if (reloaded._tag === "Failure") {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.", undefined);
    deferral.installInProgress = false;
    // Let later checks re-arm the install; the downloaded update still
    // applies at the next cold start regardless.
    deferral.pendingInstall = false;
  }
}

async function defaultConfirmInstallNow(): Promise<boolean> {
  const { Alert } = await import("react-native");
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Update ready",
      "A new version has been downloaded and installs automatically the next time you leave the app. Install it now instead?",
      [
        { onPress: () => resolve(false), style: "cancel", text: "Later" },
        { onPress: () => resolve(true), text: "Install Now" },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

async function defaultFlushPendingWrites(): Promise<void> {
  // Attempt every flush before surfacing the first failure, so one broken
  // store cannot keep the others from landing.
  const results = await Promise.allSettled([
    import("../../state/use-composer-drafts").then((drafts) => drafts.flushComposerDrafts()),
    import("../../state/thread-outbox").then((outbox) => outbox.flushThreadOutbox()),
  ]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

async function defaultIsSafeToRestartInBackground(): Promise<boolean> {
  const { isForegroundHandoffActive } = await import("../../lib/foreground-handoff");
  if (isForegroundHandoffActive()) return false;
  const { AppState } = await import("react-native");
  return AppState.currentState === "background";
}

function defaultOnNextBackground(apply: () => void, includeCurrent: boolean): void {
  void import("react-native").then(({ AppState }) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      subscription.remove();
      apply();
    });
    // The app may already have backgrounded while this module was loading;
    // the listener alone would then wait a whole extra foreground cycle.
    if (includeCurrent && AppState.currentState === "background") {
      subscription.remove();
      apply();
    }
  });
}

/**
 * How long the app may stay foregrounded with a downloaded update before the
 * install prompt appears. Long enough that most sessions background naturally
 * and install silently instead.
 */
export const DEFERRED_INSTALL_PROMPT_AFTER_MS = 30 * 60 * 1000;

/**
 * The window resets on every backgrounding because that is exactly when the
 * deferred install gets its chance. iOS "inactive" blips (app switcher, a
 * pulled-down notification shade) leave the timer running.
 */
function defaultOnForegroundStay(apply: () => void): void {
  void import("react-native").then(({ AppState }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer ??= setTimeout(() => {
        subscription.remove();
        apply();
      }, DEFERRED_INSTALL_PROMPT_AFTER_MS);
    };
    const disarm = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") arm();
      else if (state === "background") disarm();
    });
    if (AppState.currentState === "active") arm();
  });
}

const defaultAppUpdateEnvironment: AppUpdateEnvironment = {
  confirmInstallNow: defaultConfirmInstallNow,
  flushPendingWrites: defaultFlushPendingWrites,
  isSafeToRestartInBackground: defaultIsSafeToRestartInBackground,
  onNextBackground: defaultOnNextBackground,
  onForegroundStay: defaultOnForegroundStay,
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
