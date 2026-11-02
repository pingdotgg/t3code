import type { ReactNode } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  scope: vi.fn(),
  update: vi.fn(),
  writeAllowed: vi.fn(),
}));

vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: mocks.scope }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: mocks.settings,
  useScopedSettingsMixed: () => false,
  useScopedSettingsWriteAllowed: mocks.writeAllowed,
  useUpdateScopedSettings: () => mocks.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control, children }: { control?: ReactNode; children?: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  ),
  SettingResetButton: () => null,
}));

import { NewChatPromptSettings } from "./NewChatPromptSettings";

function setup() {
  mocks.update.mockReset();
  mocks.settings.mockReturnValue({
    ...DEFAULT_UNIFIED_SETTINGS,
    newChatPrompt: "Saved instructions",
  });
  mocks.writeAllowed.mockReturnValue(true);
  const local = { environmentId: "local", serverConfig: {} };
  const remote = { environmentId: "remote", serverConfig: {} };
  const scope = {
    targets: [
      { environmentId: "local", projectId: null },
      { environmentId: "remote", projectId: null },
    ],
    connectedEnvironments: [local, remote],
  };
  mocks.scope.mockReturnValue(scope);
  return scope;
}

it("keeps the saved prompt visible and blocks edits when one selected environment locks it", async () => {
  const scope = setup();
  await using screen = await render(<NewChatPromptSettings />);
  const input = screen.getByRole("textbox", { name: "New chat prompt" });
  await userEvent.click(input);
  await userEvent.keyboard("{End} updated");
  await userEvent.click(document.body);
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    newChatPrompt: "Saved instructions updated",
  });

  mocks.update.mockClear();
  mocks.settings.mockReturnValue({
    ...DEFAULT_UNIFIED_SETTINGS,
    newChatPrompt: "Organization instructions",
  });
  mocks.scope.mockReturnValue({
    ...scope,
    connectedEnvironments: [
      scope.connectedEnvironments[0],
      {
        environmentId: "remote",
        serverConfig: {
          managedPolicy: { organization: "Example Corp", lockedSettings: ["newChatPrompt"] },
        },
      },
    ],
  });
  await screen.rerender(<NewChatPromptSettings />);
  await userEvent.click(input);
  await userEvent.keyboard("{End} unsaved edits");
  await userEvent.click(document.body);
  await expect.element(input).toHaveValue("Organization instructions");
  await expect.element(screen.getByText("Managed by Example Corp.")).toBeVisible();
  expect(mocks.update).not.toHaveBeenCalled();
});
