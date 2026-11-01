import * as Updates from "expo-updates";
// Metro namespace imports evaluate unrelated React Native getters, including unavailable native modules.
import { AppState } from "react-native";

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

export interface AppUpdateEnvironment {
  readonly confirmInstallNow: () => Promise<boolean>;
  readonly flushPendingWrites: () => Promise<void>;
  /** Re-check background state after flushing; exclude app-initiated handoffs such as image pickers. */
  readonly isSafeToRestartInBackground: () => Promise<boolean>;
  /** includeCurrent covers module-load backgrounding; omit after failure to prevent tight same-session retries. */
  readonly onNextBackground: (apply: () => void, includeCurrent: boolean) => void;
  readonly onForegroundStay: (apply: () => void) => void;
}

export interface AppUpdateDeferral {
  pendingInstall: boolean;
  installInProgress: boolean;
}

export function createAppUpdateDeferral(): AppUpdateDeferral {
  return { pendingInstall: false, installInProgress: false };
}

const appUpdateDeferral = createAppUpdateDeferral();

interface AppUpdateCheckOptions {
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
  // Snapshot listeners so reentrant subscribers receive only observeAppUpdateCheck's explicit replay.
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
  // Rollback directives report isAvailable: false and isRollBackToEmbedded: true; still drop the running OTA.
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

  if (options.applyMode === "immediate" || fetched.value.isRollBackToEmbedded) {
    const outcome = await installAppUpdate(
      client,
      environment,
      deferral,
      options,
      options.applyMode === "immediate",
    );
    if (outcome === "flush-failed") {
      setState("ready");
      armDeferredAppUpdateInstall(client, environment, deferral);
    }
    return;
  }

  setState("ready");
  armDeferredAppUpdateInstall(client, environment, deferral);
}

type AppUpdateInstallOutcome = "installed" | "flush-failed" | "restart-failed";

/** Flush persistence and wait for backgrounding before restarting mounted native surfaces. */
async function installAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  options: AppUpdateCheckOptions,
  userRequested: boolean,
): Promise<AppUpdateInstallOutcome> {
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

async function installPendingAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const outcome = await installAppUpdate(client, environment, deferral, options, true);
  if (outcome === "restart-failed") {
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

async function promptDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): Promise<void> {
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  const installNow = await settlePromise(() => environment.confirmInstallNow());
  if (installNow._tag !== "Success" || !installNow.value) return;
  // Backgrounding may already have started deferred restart while the alert was open; ignore stale acceptance.
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
      reportUpdateFailure(flushed, "Could not save pending state.", undefined);
    }
    deferral.installInProgress = false;
    // Wait for a fresh background transition after failure to avoid same-session retry loops.
    scheduleDeferredAppUpdateInstall(client, environment, deferral, false);
    return;
  }
  const reloaded = await settlePromise(() => client.reloadAsync());
  if (reloaded._tag === "Failure") {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.", undefined);
    deferral.installInProgress = false;
    deferral.pendingInstall = false;
  }
}

async function defaultConfirmInstallNow(): Promise<boolean> {
  const Dialog = await import("../../components/ui/Dialog");
  return new Promise<boolean>((resolve) => {
    Dialog.alert(
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
  return AppState.currentState === "background";
}

function defaultOnNextBackground(apply: () => void, includeCurrent: boolean): void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state !== "background") return;
    subscription.remove();
    apply();
  });
  if (includeCurrent && AppState.currentState === "background") {
    subscription.remove();
    apply();
  }
}

const DEFERRED_INSTALL_PROMPT_AFTER_MS = 30 * 60 * 1000;

/** iOS inactive blips, including the app switcher, leave this timer running. */
function defaultOnForegroundStay(apply: () => void): void {
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

const FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS = 15 * 60 * 1000;

function shouldRecheckAppUpdateOnForeground(
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

/**
 * App-lifetime update checks: one at launch, then again when the app returns
 * from a long stay in the background.
 */
export function installAppUpdateChecks(
  client: AppUpdateClient = Updates,
  deferral: AppUpdateDeferral = appUpdateDeferral,
): () => void {
  if (!isAppUpdateCheckAvailable(client)) return () => undefined;
  void runAppUpdateCheck({ client, deferral });
  let backgroundedAtMs: number | null = null;
  const subscription = AppState.addEventListener("change", (state) => {
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
  return () => subscription.remove();
}
