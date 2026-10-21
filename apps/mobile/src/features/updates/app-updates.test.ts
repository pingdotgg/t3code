import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAppUpdateDeferral,
  createAppUpdateLaunchCheck,
  runAppUpdateCheck,
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

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
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

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
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
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
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
});
