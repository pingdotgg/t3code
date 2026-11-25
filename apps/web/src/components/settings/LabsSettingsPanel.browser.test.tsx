import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  workflowsEnabled: true,
  mixed: false,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    workflowsEnabled: state.workflowsEnabled,
  })) as never,
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control }) => <div>{control}</div>,
}));

import { WorkflowSkippedRunsRow } from "./LabsSettingsPanel";

describe("WorkflowSkippedRunsRow", () => {
  it("saves the number of skipped runs kept on blur and on Enter", async () => {
    state.workflowsEnabled = true;
    state.mixed = false;
    state.updateSettings.mockReset();
    await using _screen = await render(<WorkflowSkippedRunsRow />, { router: false });

    const field = page.getByRole("textbox", { name: "Skipped runs kept" });
    await expect.element(field).toHaveValue("500");
    await userEvent.clear(field);
    await userEvent.type(field, "50");
    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenCalledWith({ workflowSkippedRunsKept: 50 });
    await userEvent.clear(field);
    await userEvent.type(field, "40");
    await userEvent.keyboard("{Enter}");
    expect(state.updateSettings).toHaveBeenLastCalledWith({ workflowSkippedRunsKept: 40 });
    await expect.element(field).toHaveFocus();
  });

  it("saves to every target when they hold different numbers, even the first one's", async () => {
    state.workflowsEnabled = true;
    state.mixed = true;
    state.updateSettings.mockReset();
    await using _screen = await render(<WorkflowSkippedRunsRow />, { router: false });

    const field = page.getByRole("textbox", { name: "Skipped runs kept" });
    await expect.element(field).toHaveValue("");
    await expect.element(field).toHaveAttribute("placeholder", "Mixed");
    await userEvent.type(field, "500");
    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenCalledWith({ workflowSkippedRunsKept: 500 });
  });

  it("shows nothing while workflows are off", async () => {
    state.workflowsEnabled = false;
    await using screen = await render(<WorkflowSkippedRunsRow />, { router: false });
    expect(screen.container.textContent).toBe("");
  });
});
