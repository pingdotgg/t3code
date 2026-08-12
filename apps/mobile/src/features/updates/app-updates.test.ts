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
} {
  const backgroundCallbacks: Array<() => void> = [];
  return {
    backgroundCallbacks,
    environment: {
      confirmInstallNow: vi.fn(async () => true),
      flushPendingWrites: vi.fn(async () => {}),
      onNextBackground: vi.fn((apply: () => void) => {
        backgroundCallbacks.push(apply);
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

  it("downloads, prompts, and restarts when the user accepts the install", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      client,
      deferral: createAppUpdateDeferral(),
      environment,
      onStateChange: (state) => states.push(state),
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(environment.confirmInstallNow).toHaveBeenCalledOnce();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "downloading", "ready", "restarting"]);
  });

  it("flushes pending writes before restarting", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();

    await runAppUpdateCheck({ client, deferral: createAppUpdateDeferral(), environment });

    const flushOrder = vi.mocked(environment.flushPendingWrites).mock.invocationCallOrder[0]!;
    const reloadOrder = vi.mocked(client.reloadAsync).mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(reloadOrder);
  });

  it("defers a declined install to the next backgrounding", async () => {
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({
      confirmInstallNow: vi.fn(async () => false),
    });
    const deferral = createAppUpdateDeferral();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      client,
      deferral,
      environment,
      onStateChange: (state) => states.push(state),
    });

    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(states).toEqual(["checking", "downloading", "ready"]);
    expect(deferral.pendingInstall).toBe(true);
    expect(backgroundCallbacks).toHaveLength(1);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    expect(environment.flushPendingWrites).toHaveBeenCalled();
  });

  it("arms the deferred install once across repeated declines", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment({
      confirmInstallNow: vi.fn(async () => false),
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    await runAppUpdateCheck({ client, deferral, environment });

    expect(environment.onNextBackground).toHaveBeenCalledOnce();
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
