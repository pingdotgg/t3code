import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";

/** Shows only when every machine in scope runs Linux, since only Linux servers honor it. */
export function ReflinkWorktreesRow() {
  const setting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.reflinkWorktrees !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...setting("worktree-reflink")}
      settingKeys={["reflinkWorktrees"]}
      description="Clone new worktrees copy-on-write from a checkout cached on their location’s drive, so they share disk space until files change. Other drives use Git’s checkout. Turning it off deletes the cache."
      resetAction={
        settings.reflinkWorktrees !== DEFAULT_UNIFIED_SETTINGS.reflinkWorktrees ? (
          <SettingResetButton
            ariaLabel="Reset reflink worktrees to default"
            onClick={() =>
              updateSettings({ reflinkWorktrees: DEFAULT_UNIFIED_SETTINGS.reflinkWorktrees })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["reflinkWorktrees"]}
          checked={settings.reflinkWorktrees}
          onCheckedChange={(checked) => updateSettings({ reflinkWorktrees: Boolean(checked) })}
          aria-label="Reflink worktrees"
        />
      }
    />
  );
}
