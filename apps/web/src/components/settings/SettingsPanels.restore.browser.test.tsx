import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ mixedDirectory: false }));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useScopedSettingsMixed: (keys) => keys.includes("newProjectDirectory") && state.mixedDirectory,
  useUpdateScopedSettings: () => vi.fn(),
}));

import { useSettingsRestore } from "./SettingsPanels";

function RestoreSummary() {
  const { changedSettingLabels } = useSettingsRestore();
  return <output>{changedSettingLabels.join(", ")}</output>;
}

it("includes a custom project location on another environment in restore confirmation", async () => {
  state.mixedDirectory = false;
  await using screen = await render(<RestoreSummary />);
  await expect.element(screen.getByRole("status")).not.toHaveTextContent("New project location");
  state.mixedDirectory = true;
  await screen.rerender(<RestoreSummary />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("New project location");
});
