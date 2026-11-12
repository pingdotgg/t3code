import type { ReactNode } from "react";
import { DEFAULT_UNIFIED_SETTINGS, PROJECT_SCOPED_SERVER_SETTING_KEYS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  scope: vi.fn(),
  update: vi.fn(),
  writeAllowed: vi.fn(),
}));

vi.mock("./SettingsScopeContext", async () => {
  const { createContext, use } = await import("react");
  const Scope = createContext<unknown>(null);
  return {
    SettingsScopeProvider: ({ children }: { children: ReactNode }) => (
      <Scope value={mocks.scope()}>{children}</Scope>
    ),
    useSettingsScope: () => use(Scope),
    useOptionalSettingsScope: () => use(Scope),
  };
});
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettingsAvailable: () => true,
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Settings unavailable",
}));
vi.mock("./SettingInheritance", () => ({ SettingInheritance: () => null }));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: mocks.settings,
  useScopedSettingsMixed: () => false,
  useScopedSettingsWriteAllowed: mocks.writeAllowed,
  useUpdateScopedSettings: () => mocks.update,
  useClearScopedSettings: () => () => {},
  useClearProjectOverrides: () => () => {},
}));
import { NewChatPromptSettings } from "./NewChatPromptSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";

function ui() {
  return (
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <NewChatPromptSettings />
    </SettingsScopeProvider>
  );
}

function setup() {
  mocks.update.mockReset();
  mocks.settings.mockReturnValue({
    ...DEFAULT_UNIFIED_SETTINGS,
    newChatPrompt: "Saved instructions",
  });
  mocks.writeAllowed.mockReturnValue(true);
  const local = { environmentId: "local", serverConfig: { settings: DEFAULT_UNIFIED_SETTINGS } };
  const remote = { environmentId: "remote", serverConfig: { settings: DEFAULT_UNIFIED_SETTINGS } };
  const scope = {
    scope: { kind: "environment", environmentIds: ["local", "remote"] },
    groups: [],
    environments: [local, remote],
    targets: [local, remote].map((environment) => ({
      environmentId: environment.environmentId,
      projectId: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      sources: Object.fromEntries(
        PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
      ),
    })),
    connectedEnvironments: [local, remote],
  };
  mocks.scope.mockReturnValue(scope);
  return scope;
}

it("applies the prompt and enable policy locks independently across selected environments", async () => {
  const scope = setup();
  await using screen = await render(ui());
  const input = screen.getByRole("textbox", { name: "New chat prompt" });
  await userEvent.click(input);
  await userEvent.keyboard("{End} updated");
  await userEvent.click(document.body);
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    newChatPrompt: "Saved instructions updated",
  });

  mocks.update.mockClear();
  await userEvent.click(screen.getByRole("switch", { name: "Enable new chat prompt" }));
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    newChatPromptEnabled: true,
    newChatPrompt: "Saved instructions updated",
  });

  await userEvent.click(input);
  await userEvent.keyboard("{End} newer");
  mocks.settings.mockReturnValue({
    ...DEFAULT_UNIFIED_SETTINGS,
    newChatPrompt: "Saved instructions updated",
  });
  await screen.rerender(ui());
  await expect.element(input).toHaveValue("Saved instructions updated newer");
  await expect.element(input).toHaveFocus();

  await userEvent.click(
    screen.getByRole("button", { name: "Reset saved instructions to default" }),
  );
  mocks.update.mockClear();
  await userEvent.click(screen.getByRole("switch", { name: "Enable new chat prompt" }));
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ newChatPromptEnabled: true });

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
          settings: DEFAULT_UNIFIED_SETTINGS,
          managedPolicy: { organization: "Example Corp", lockedSettings: ["newChatPrompt"] },
        },
      },
    ],
  });
  await screen.rerender(ui());
  await userEvent.click(input);
  await userEvent.keyboard("{End} unsaved edits");
  await userEvent.click(document.body);
  await expect.element(input).toHaveValue("Organization instructions");
  await expect.element(screen.getByText("Managed by Example Corp.")).toBeVisible();
  expect(mocks.update).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("switch", { name: "Enable new chat prompt" }));
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ newChatPromptEnabled: true });

  mocks.update.mockClear();
  mocks.scope.mockReturnValue({
    ...scope,
    connectedEnvironments: [
      scope.connectedEnvironments[0],
      {
        environmentId: "remote",
        serverConfig: {
          settings: DEFAULT_UNIFIED_SETTINGS,
          managedPolicy: { organization: "Example Corp", lockedSettings: ["newChatPromptEnabled"] },
        },
      },
    ],
  });
  await screen.rerender(ui());
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[role="switch"]')?.closest("[inert]")).not.toBeNull(),
  );
  await userEvent.click(input);
  await userEvent.keyboard("{End} updated");
  await userEvent.click(document.body);
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    newChatPrompt: "Organization instructions updated",
  });
});
