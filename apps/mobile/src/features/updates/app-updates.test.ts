import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAppUpdateDeferral,
  createAppUpdateLaunchCheck,
  FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
  shouldRecheckAppUpdateOnForeground,
  type AppUpdateCheckState,
  type AppUpdateClient,
  type AppUpdateEnvironment,
} from "./app-updates";

vi.mock("expo-updates", () => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

function makeUpdateClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    isEnabled: true,
    checkForUpdateAsync: vi.fn(async () => ({
      isAvailable: false,
      isRollBackToEmbedded: false,
    })),
    fetchUpdateAsync: vi.fn(async () => ({
      isNew: true,
      isRollBackToEmbedded: false,
    })),
    reloadAsync: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeUpdateEnvironment(overrides: Partial<AppUpdateEnvironment> = {}): {
  readonly backgroundCallbacks: Array<() => void>;
  readonly environment: AppUpdateEnvironment;
  readonly foregroundStayCallbacks: Array<() => void>;
} {
  const backgroundCallbacks: Array<() => void> = [];
  const foregroundStayCallbacks: Array<() => void> = [];
  return {
    backgroundCallbacks,
    foregroundStayCallbacks,
    environment: {
      confirmInstallNow: vi.fn(async () => true),
      flushPendingWrites: vi.fn(async () => {}),
      isSafeToRestartInBackground: vi.fn(async () => true),
      onNextBackground: vi.fn((apply: () => void, _includeCurrent: boolean) => {
        backgroundCallbacks.push(apply);
      }),
      onForegroundStay: vi.fn((apply: () => void) => {
        foregroundStayCallbacks.push(apply);
      }),
      ...overrides,
    },
  };
}

function makeAvailableUpdateClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return makeUpdateClient({
    checkForUpdateAsync: vi.fn(async () => ({
      isAvailable: true,
      isRollBackToEmbedded: false,
    })),
    ...overrides,
  });
}

describe("runAppUpdateCheck", () => {
  it("does nothing while running from the Metro development server", async () => {
    vi.stubGlobal("__DEV__", true);
    const client = makeUpdateClient();

    try {
      await runAppUpdateCheck({ client });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it("downloads silently and installs at the next backgrounding", async () => {
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      client,
      deferral,
      environment,
      onStateChange: (state) => states.push(state),
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(states).toEqual(["checking", "downloading", "ready"]);
    expect(deferral.pendingInstall).toBe(true);
    expect(backgroundCallbacks).toHaveLength(1);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    expect(environment.flushPendingWrites).toHaveBeenCalled();
  });

  it("flushes pending writes before restarting", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();

    await runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral: createAppUpdateDeferral(),
      environment,
    });

    const flushOrder = vi.mocked(environment.flushPendingWrites).mock.invocationCallOrder[0]!;
    const reloadOrder = vi.mocked(client.reloadAsync).mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(reloadOrder);
  });

  it("prompts once the app has stayed foregrounded with the download waiting", async () => {
    const client = makeAvailableUpdateClient();
    const { environment, foregroundStayCallbacks } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(foregroundStayCallbacks).toHaveLength(1);

    foregroundStayCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    expect(environment.confirmInstallNow).toHaveBeenCalledOnce();
    expect(environment.flushPendingWrites).toHaveBeenCalled();
  });

  it("keeps the background install armed when the foreground prompt is declined", async () => {
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment, foregroundStayCallbacks } = makeUpdateEnvironment({
      confirmInstallNow: vi.fn(async () => false),
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });

    foregroundStayCallbacks[0]!();
    await vi.waitFor(() => expect(environment.confirmInstallNow).toHaveBeenCalledOnce());
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
  });

  it("skips the foreground prompt once the install is no longer pending", async () => {
    const client = makeAvailableUpdateClient();
    const { environment, foregroundStayCallbacks } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });

    // A failed deferred reload resets the deferral before the stay fires.
    deferral.pendingInstall = false;
    foregroundStayCallbacks[0]!();

    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it("re-arms instead of restarting when the app is no longer safely backgrounded", async () => {
    const client = makeAvailableUpdateClient();
    const safe = vi.fn(async () => false);
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({
      isSafeToRestartInBackground: safe,
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    expect(backgroundCallbacks).toHaveLength(1);
    // Arming may fire for an already-backgrounded app…
    expect(vi.mocked(environment.onNextBackground).mock.calls[0]![1]).toBe(true);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(backgroundCallbacks).toHaveLength(2));
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);
    // …but a re-arm must wait for a fresh transition, or an unsafe attempt
    // would retry in a tight loop within the same background session.
    expect(vi.mocked(environment.onNextBackground).mock.calls[1]![1]).toBe(false);

    safe.mockResolvedValue(true);
    backgroundCallbacks[1]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
  });

  it("resets the deferral when the deferred restart fails", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeAvailableUpdateClient({
      reloadAsync: vi.fn(async () => {
        throw new Error("reload rejected");
      }),
    });
    const { backgroundCallbacks, environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    backgroundCallbacks[0]!();

    await vi.waitFor(() => expect(deferral.pendingInstall).toBe(false));
    reportError.mockRestore();
  });

  it("arms the deferred install once across repeated checks", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    await runAppUpdateCheck({ client, deferral, environment });

    expect(environment.onNextBackground).toHaveBeenCalledOnce();
    expect(environment.onForegroundStay).toHaveBeenCalledOnce();
  });

  it("restarts into an already-downloaded update when the user asks to install", async () => {
    const client = makeUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();
    deferral.pendingInstall = true;

    await runAppUpdateCheck({ applyMode: "immediate", client, deferral, environment });

    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
  });

  it("honors an immediate request that joined an in-flight background check", async () => {
    let resolveCheck!: (result: {
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((resolve) => {
      resolveCheck = resolve;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const { environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    const backgroundCheck = runAppUpdateCheck({ client, deferral, environment });
    const manualCheck = runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral,
      environment,
    });

    resolveCheck({ isAvailable: true, isRollBackToEmbedded: false });
    await Promise.all([backgroundCheck, manualCheck]);

    // The coalesced background check deferred the download, but the manual
    // caller explicitly asked to install, so the restart happens anyway.
    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
  });

  it("runs a single restart when the deferred install races the foreground prompt", async () => {
    const client = makeAvailableUpdateClient();
    let releaseFlush!: () => void;
    const blockedFlush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const flushPendingWrites = vi.fn(async (): Promise<void> => {});
    const { backgroundCallbacks, environment, foregroundStayCallbacks } = makeUpdateEnvironment({
      flushPendingWrites,
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    flushPendingWrites.mockReturnValue(blockedFlush);

    // The deferred install starts and blocks on its flush; the foreground
    // prompt firing in that window must not begin a second restart.
    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(flushPendingWrites).toHaveBeenCalledOnce());
    foregroundStayCallbacks[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();

    releaseFlush();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
  });

  it("holds the deferred restart and re-arms when the pre-restart flush fails", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({
      flushPendingWrites: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    backgroundCallbacks[0]!();

    await vi.waitFor(() => expect(backgroundCallbacks).toHaveLength(2));
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);
    reportError.mockRestore();
  });

  it("restarts without prompting when the caller asked for an immediate install", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral: createAppUpdateDeferral(),
      environment,
      onStateChange: (state) => states.push(state),
    });

    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "downloading", "restarting"]);
  });

  it("holds an automatic rollback restart when the flush fails and re-arms it", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => ({
        isAvailable: false,
        isRollBackToEmbedded: true,
      })),
      fetchUpdateAsync: vi.fn(async () => ({
        isNew: false,
        isRollBackToEmbedded: true,
      })),
    });
    const flushPendingWrites = vi.fn(async (): Promise<void> => {
      throw new Error("storage unavailable");
    });
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({ flushPendingWrites });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });

    // Nobody asked for this restart, so it must not discard the state it
    // failed to land; the rollback waits armed for the next backgrounding.
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);
    expect(backgroundCallbacks).toHaveLength(1);

    flushPendingWrites.mockResolvedValue(undefined);
    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    reportError.mockRestore();
  });

  it("still restarts a user-requested install when the flush fails", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment({
      flushPendingWrites: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });

    await runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral: createAppUpdateDeferral(),
      environment,
    });

    expect(client.reloadAsync).toHaveBeenCalledOnce();
    reportError.mockRestore();
  });

  it("restarts into the embedded bundle for a rollback directive", async () => {
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => ({
        isAvailable: false,
        isRollBackToEmbedded: true,
      })),
      fetchUpdateAsync: vi.fn(async () => ({
        isNew: false,
        isRollBackToEmbedded: true,
      })),
    });
    const { environment } = makeUpdateEnvironment();

    await runAppUpdateCheck({ client, deferral: createAppUpdateDeferral(), environment });

    expect(client.fetchUpdateAsync).toHaveBeenCalledOnce();
    // A rollback pulls a broken bundle, so it never waits on the prompt.
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
  });

  it("stops quietly when the running bundle is current", async () => {
    const client = makeUpdateClient();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({ client, onStateChange: (state) => states.push(state) });

    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(states).toEqual(["checking", "current"]);
  });

  it("reports manual failures without continuing the update", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const failures: string[] = [];
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      client,
      onFailure: (message) => failures.push(message),
      onStateChange: (state) => states.push(state),
    });

    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(failures).toEqual(["offline"]);
    expect(states).toEqual(["checking", "idle"]);
    reportError.mockRestore();
  });

  it.each(["ERR_NOT_AVAILABLE_IN_DEV_CLIENT", "ERR_UPDATES_DISABLED"])(
    "treats Expo's %s failure as an unavailable update check",
    async (code) => {
      const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = Object.assign(new Error("Updates are unavailable"), { code });
      const client = makeUpdateClient({
        checkForUpdateAsync: vi.fn(async () => {
          throw error;
        }),
      });
      const failures: string[] = [];
      const states: AppUpdateCheckState[] = [];

      await runAppUpdateCheck({
        client,
        onFailure: (message) => failures.push(message),
        onStateChange: (state) => states.push(state),
      });

      expect(reportError).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
      expect(states).toEqual(["checking", "idle"]);
      reportError.mockRestore();
    },
  );

  it("coalesces overlapping launch and manual checks", async () => {
    let resolveCheck!: (result: {
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((resolve) => {
      resolveCheck = resolve;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const checkOnLaunch = createAppUpdateLaunchCheck(client);
    const manualStates: AppUpdateCheckState[] = [];

    const launchCheck = checkOnLaunch();
    const manualCheck = runAppUpdateCheck({
      client,
      onStateChange: (state) => manualStates.push(state),
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(manualStates).toEqual(["checking"]);

    resolveCheck({
      isAvailable: false,
      isRollBackToEmbedded: false,
    });
    await Promise.all([launchCheck, manualCheck]);

    expect(manualStates).toEqual(["checking", "current"]);

    await runAppUpdateCheck({ client });
    expect(client.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it("forwards failures to a manual check coalesced with the launch check", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectCheck!: (error: Error) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((_resolve, reject) => {
      rejectCheck = reject;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const checkOnLaunch = createAppUpdateLaunchCheck(client);
    const failures: string[] = [];
    const manualStates: AppUpdateCheckState[] = [];

    const launchCheck = checkOnLaunch();
    const manualCheck = runAppUpdateCheck({
      client,
      onFailure: (message) => failures.push(message),
      onStateChange: (state) => manualStates.push(state),
    });

    rejectCheck(new Error("offline"));
    await Promise.all([launchCheck, manualCheck]);

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(failures).toEqual(["offline"]);
    expect(manualStates).toEqual(["checking", "idle"]);
    reportError.mockRestore();
  });

  it("publishes the in-flight check before a state callback can re-enter", async () => {
    let resolveCheck!: (result: {
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((resolve) => {
      resolveCheck = resolve;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const reentrantStates: AppUpdateCheckState[] = [];
    let reentrantCheck: Promise<void> | undefined;
    let didReenter = false;

    const initialCheck = runAppUpdateCheck({
      client,
      onStateChange: (state) => {
        if (state !== "checking" || didReenter) return;
        didReenter = true;
        reentrantCheck = runAppUpdateCheck({
          client,
          onStateChange: (reentrantState) => reentrantStates.push(reentrantState),
        });
      },
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(reentrantCheck).toBeDefined();
    expect(reentrantStates).toEqual(["checking"]);

    resolveCheck({
      isAvailable: false,
      isRollBackToEmbedded: false,
    });
    await Promise.all([initialCheck, reentrantCheck]);

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(reentrantStates).toEqual(["checking", "current"]);
  });
});

describe("createAppUpdateLaunchCheck", () => {
  it("checks at most once for each JavaScript launch", async () => {
    const client = makeUpdateClient();
    const checkOnLaunch = createAppUpdateLaunchCheck(client);

    const first = checkOnLaunch();
    const second = checkOnLaunch();
    await first;

    expect(second).toBeUndefined();
    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
  });

  it("does nothing when Expo updates are disabled", () => {
    const client = makeUpdateClient({ isEnabled: false });
    const checkOnLaunch = createAppUpdateLaunchCheck(client);

    expect(checkOnLaunch()).toBeUndefined();
    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
  });
});

describe("shouldRecheckAppUpdateOnForeground", () => {
  it("requires a meaningful background gap", () => {
    expect(shouldRecheckAppUpdateOnForeground(null, 100_000, false)).toBe(false);
    expect(
      shouldRecheckAppUpdateOnForeground(
        100_000,
        100_000 + FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS - 1,
        false,
      ),
    ).toBe(false);
    expect(
      shouldRecheckAppUpdateOnForeground(
        100_000,
        100_000 + FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS,
        false,
      ),
    ).toBe(true);
  });

  it("stays quiet while a downloaded update waits for its install", () => {
    expect(
      shouldRecheckAppUpdateOnForeground(
        100_000,
        100_000 + FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS,
        true,
      ),
    ).toBe(false);
  });
});

describe("registerHiddenUpdateTap", () => {
  it("unlocks the manual check on the fifth tap", () => {
    let count = 0;

    for (let tap = 1; tap <= 5; tap += 1) {
      const result = registerHiddenUpdateTap(count);
      expect(result.shouldCheck).toBe(tap === 5);
      count = result.nextCount;
    }

    expect(count).toBe(0);
  });
});
