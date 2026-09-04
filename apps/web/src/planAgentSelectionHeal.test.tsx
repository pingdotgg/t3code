import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { ProviderInstanceId, type UnifiedSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  canWriteSettings: false,
  settingsHydrated: true,
  settings: null as Pick<
    UnifiedSettings,
    "planModeEnabled" | "textGenerationModelSelection" | "sourceControlWriterModelSelection"
  > | null,
  updateSettings: vi.fn(),
}));

vi.mock("./hooks/useSettings", () => ({
  usePrimarySettings: (selector: (settings: NonNullable<typeof testState.settings>) => unknown) =>
    selector(testState.settings!),
  useClientSettingsHydrated: () => testState.settingsHydrated,
  useUpdatePrimarySettings: () => testState.updateSettings,
}));
vi.mock("./state/environments", () => ({
  usePrimaryEnvironmentId: () => "older-primary",
}));
vi.mock("./state/session", () => ({
  useEnvironmentScope: (environmentId: string, scope: string) =>
    environmentId === "older-primary" && scope === "settings:write" && testState.canWriteSettings,
}));

import { PlanAgentSelectionHeal } from "./planAgentSelectionHeal";

let renderer: ReactTestRenderer | null = null;
const instanceId = ProviderInstanceId.make("opencode");
const selection = createModelSelection(instanceId, "opencode/gpt-5.4", [
  { id: "agent", value: "plan" },
]);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.canWriteSettings = false;
  testState.settingsHydrated = true;
  testState.settings = {
    planModeEnabled: false,
    textGenerationModelSelection: selection,
    sourceControlWriterModelSelection: null,
  };
  testState.updateSettings.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("PlanAgentSelectionHeal", () => {
  it("waits for permission and retries when the same environment's grant resolves", async () => {
    await act(() => {
      renderer = create(<PlanAgentSelectionHeal />);
    });
    expect(testState.updateSettings).not.toHaveBeenCalled();

    testState.canWriteSettings = true;
    await act(() => {
      renderer?.update(<PlanAgentSelectionHeal />);
    });
    expect(testState.updateSettings).toHaveBeenCalledExactlyOnceWith({
      textGenerationModelSelection: createModelSelection(instanceId, "opencode/gpt-5.4", []),
    });
  });

  it("does not heal before client preferences load even when the server grants writes", async () => {
    testState.canWriteSettings = true;
    testState.settingsHydrated = false;
    await act(() => {
      renderer = create(<PlanAgentSelectionHeal />);
    });
    expect(testState.updateSettings).not.toHaveBeenCalled();

    testState.settingsHydrated = true;
    await act(() => {
      renderer?.update(<PlanAgentSelectionHeal />);
    });
    expect(testState.updateSettings).toHaveBeenCalledOnce();
  });
});
