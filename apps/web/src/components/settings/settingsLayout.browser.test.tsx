import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import type { useOptionalSettingsScope } from "./SettingsScopeContext";
import "../../index.css";

const state = vi.hoisted(() => ({ available: false, scoped: false }));

function setup({ available, scoped }: { available: boolean; scoped: boolean }) {
  state.available = available;
  state.scoped = scoped;
}

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettingsAvailable: () => state.available,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: () =>
    (state.scoped
      ? {
          scope: { kind: "all", environmentIds: [] },
          environments: [],
          connectedEnvironments: [],
          targets: [],
        }
      : null) as ReturnType<typeof useOptionalSettingsScope>,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: () => new Map(),
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));

it.each([
  { available: false, scoped: false, reason: PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE },
  { available: false, scoped: true, reason: PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE },
  {
    available: true,
    scoped: true,
    reason: "Reconnect the selected environment to change this setting.",
  },
  {
    available: true,
    scoped: false,
    reason: "This connection lacks permission to change settings on the primary environment.",
  },
])(
  "explains server settings availability ($available, $scoped)",
  async ({ available, scoped, reason }) => {
    setup({ available, scoped });
    const changed = vi.fn();
    await using screen = await render(
      <SettingsRow
        title="Provider update checks"
        serverScoped
        control={<Switch checked onCheckedChange={changed} aria-label="Check provider versions" />}
      />,
    );

    await userEvent.tab();
    const wrapper = screen.getByRole("group", { name: "Provider update checks" });
    await expect.element(wrapper).toHaveFocus();
    await expect.element(wrapper).toHaveAttribute("aria-disabled", "true");
    await expect.element(wrapper).toHaveAccessibleDescription(reason);
    await expect.element(wrapper).toHaveStyle({ cursor: "not-allowed" });
    await expect.element(page.getByText(reason)).toBeVisible();
    await userEvent.keyboard("{Enter} ");
    expect(changed).not.toHaveBeenCalled();
  },
);
