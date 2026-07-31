import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAppUpdateLaunchCheck,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
  type AppUpdateCheckState,
  type AppUpdateClient,
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

describe("runAppUpdateCheck", () => {
  it("downloads and restarts when a new update is available", async () => {
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => ({
        isAvailable: true,
        isRollBackToEmbedded: false,
      })),
    });
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({ client, onStateChange: (state) => states.push(state) });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.fetchUpdateAsync).toHaveBeenCalledOnce();
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

    await runAppUpdateCheck({ client });

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
