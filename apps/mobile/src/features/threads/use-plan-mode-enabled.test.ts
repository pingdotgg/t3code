import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  preferences: null as unknown,
  reconciliationReady: false,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.preferences,
}));

vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: Symbol("mobile-preferences"),
}));

vi.mock("../../state/synced-client-preferences", () => ({
  usePlanModePreferenceReconciliationReady: () => testState.reconciliationReady,
}));

import { usePlanModePreferenceState } from "./use-plan-mode-enabled";

describe("usePlanModePreferenceState", () => {
  beforeEach(() => {
    testState.preferences = AsyncResult.success({ planModeEnabled: false });
    testState.reconciliationReady = false;
  });

  it("keeps send gating closed when only device preferences have loaded", () => {
    expect(usePlanModePreferenceState()).toEqual({ enabled: false, loaded: false });
  });

  it("uses the device value after reconciliation readiness", () => {
    testState.preferences = AsyncResult.success({ planModeEnabled: true });
    testState.reconciliationReady = true;

    expect(usePlanModePreferenceState()).toEqual({ enabled: true, loaded: true });
  });
});
