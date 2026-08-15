import { EnvironmentId, type PatchSyncedClientPreferencesRequest } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

const testState = vi.hoisted(() => ({
  primaryEnvironmentIds: new Array<EnvironmentId>(),
  sessionAtom: Symbol("session"),
  updateSettingsAtom: Symbol("update-settings"),
  patchPreferencesAtom: Symbol("patch-preferences"),
  serverSettingsAtom: Symbol("server-settings"),
  sessionEnvironmentIds: new Array<EnvironmentId>(),
  updateSettings: vi.fn(),
  patchPreferences: vi.fn(),
  setClientSettings: vi.fn(async () => undefined),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useMemo: reactHookHarness.useMemo,
    useSyncExternalStore: <Snapshot>(
      _subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => Snapshot,
    ): Snapshot => getSnapshot(),
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) =>
    atom === testState.serverSettingsAtom
      ? {}
      : atom === testState.sessionAtom
        ? {
            authenticated: true,
            scopes: ["orchestration:operate"],
          }
        : {
            planModeEnabled: false,
            updatedAt: "2026-08-14T12:00:00.000Z",
          },
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setClientSettings: testState.setClientSettings,
    },
  }),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: testState.primaryEnvironmentIds[0] }),
}));

vi.mock("~/state/server", () => ({
  primaryServerSettingsAtom: Symbol("primary-settings"),
  serverEnvironment: {
    settingsValueAtom: () => testState.serverSettingsAtom,
    updateSettings: testState.updateSettingsAtom,
    patchSyncedClientPreferences: testState.patchPreferencesAtom,
  },
}));

vi.mock("~/state/session", () => ({
  environmentSession: {
    sessionStateValueAtom: (environmentId: EnvironmentId) => {
      testState.sessionEnvironmentIds.push(environmentId);
      return testState.sessionAtom;
    },
  },
}));

vi.mock("~/state/shell", () => ({
  environmentShell: {
    stateValueAtom: () => Symbol("shell"),
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === testState.patchPreferencesAtom ? testState.patchPreferences : testState.updateSettings,
}));

import {
  __resetClientSettingsPersistenceForTests,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "./useSettings";

describe("useUpdateEnvironmentSettings", () => {
  beforeEach(() => {
    hooks.reset();
    __resetClientSettingsPersistenceForTests();
    testState.patchPreferences.mockReset();
    testState.patchPreferences.mockImplementation(
      async (target: {
        readonly environmentId: EnvironmentId;
        readonly input: PatchSyncedClientPreferencesRequest;
      }) =>
        AsyncResult.success({
          planModeEnabled: target.input.patch.planModeEnabled,
          updatedAt: target.input.updatedAt,
        }),
    );
    testState.setClientSettings.mockClear();
    testState.primaryEnvironmentIds.length = 0;
    testState.primaryEnvironmentIds.push(EnvironmentId.make("primary"));
    testState.sessionEnvironmentIds.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("patches synced preferences in the supplied secondary environment", () => {
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    hooks.beginRender();
    const updateSettings = useUpdateEnvironmentSettings(secondaryEnvironmentId);

    updateSettings({ planModeEnabled: true });

    expect(testState.patchPreferences).toHaveBeenCalledWith({
      environmentId: secondaryEnvironmentId,
      input: {
        patch: { planModeEnabled: true },
        updatedAt: expect.any(String),
      },
    });
  });

  it("checks synced-preference access in the supplied secondary environment", () => {
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    hooks.beginRender();

    useEnvironmentSettings(secondaryEnvironmentId);

    expect(testState.sessionEnvironmentIds).toEqual([secondaryEnvironmentId]);
  });

  it("keeps an optimistic plan mode toggle while the shell is stale", () => {
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    testState.patchPreferences.mockImplementation(() => new Promise(() => undefined));
    hooks.beginRender();
    const updateSettings = useUpdateEnvironmentSettings(secondaryEnvironmentId);

    updateSettings({ planModeEnabled: true });
    hooks.reset();
    hooks.beginRender();

    expect(
      useEnvironmentSettings(secondaryEnvironmentId, (settings) => settings.planModeEnabled),
    ).toBe(true);
  });

  it("retries a failed secondary preference patch and reconciles the UI", async () => {
    vi.useFakeTimers();
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    testState.patchPreferences
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockImplementationOnce(async (target) =>
        AsyncResult.success({
          planModeEnabled: false,
          updatedAt: target.input.updatedAt,
        }),
      );
    hooks.beginRender();
    useEnvironmentSettings(secondaryEnvironmentId);
    hooks.beginRender();
    const updateSettings = useUpdateEnvironmentSettings(secondaryEnvironmentId);

    updateSettings({ planModeEnabled: true });
    await Promise.resolve();
    hooks.beginRender();
    expect(
      useEnvironmentSettings(secondaryEnvironmentId, (settings) => settings.planModeEnabled),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(testState.patchPreferences).toHaveBeenCalledTimes(2);
    hooks.beginRender();
    expect(
      useEnvironmentSettings(secondaryEnvironmentId, (settings) => settings.planModeEnabled),
    ).toBe(false);
  });
});
