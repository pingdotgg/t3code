import { DEFAULT_SERVER_SETTINGS, managedRuntimeModeDenial } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";

import { firstManagedDenial } from "../../state/managedPolicy";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const PERMISSION_SETTINGS = [
  {
    key: "defaultRuntimeMode",
    searchId: "default-permissions",
    label: "New threads",
    description: "Default permissions for new threads. Projects can override them.",
  },
  {
    key: "sideChatRuntimeMode",
    searchId: "side-chat-permissions",
    label: "Side chats",
    description: "Permissions for new /side chats. Side chats share the parent’s worktree.",
  },
] as const;

const sideChatRuntimeModeConfig = {
  ...runtimeModeConfig,
  "inherit-parent": {
    label: "Inherit parent",
    description: "Use the parent’s current permissions, within administrator limits.",
    icon: GitForkIcon,
  },
};

/** Permission defaults apply to new threads and side chats, not existing conversations. */
export function ThreadPermissionsSettings() {
  return (
    <SettingsSection id="thread-permissions" title="Permissions">
      {PERMISSION_SETTINGS.map((setting) => (
        <ThreadPermissionRow key={setting.key} setting={setting} />
      ))}
    </SettingsSection>
  );
}

function ThreadPermissionRow({ setting }: { setting: (typeof PERMISSION_SETTINGS)[number] }) {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed([setting.key]);
  const mode = settings[setting.key];
  const PermissionIcon = sideChatRuntimeModeConfig[mode].icon;
  const options =
    setting.key === "sideChatRuntimeMode"
      ? [...runtimeModeOptions, "inherit-parent" as const]
      : runtimeModeOptions;
  return (
    <SettingsRow
      serverScoped
      settingKeys={[setting.key]}
      mixed={mixed}
      {...searchableSetting(setting.searchId)}
      title={setting.label}
      description={setting.description}
      resetAction={
        mode !== DEFAULT_SERVER_SETTINGS[setting.key] ? (
          <SettingResetButton
            label={`${setting.label.toLowerCase()} permissions`}
            onClick={() => updateSettings({ [setting.key]: DEFAULT_SERVER_SETTINGS[setting.key] })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : mode}
          onValueChange={(value) => {
            if (value) updateSettings({ [setting.key]: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={`${setting.label} permissions`}>
            {!mixed && <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            <SelectValue>{mixed ? "Mixed" : sideChatRuntimeModeConfig[mode].label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((optionMode) => {
              const option = sideChatRuntimeModeConfig[optionMode];
              const Icon = option.icon;
              const managedReason = firstManagedDenial(
                connectedEnvironments.map((environment) => environment.serverConfig?.managedPolicy),
                (policy) =>
                  optionMode === "inherit-parent"
                    ? undefined
                    : managedRuntimeModeDenial(policy, optionMode),
              );
              return (
                <SelectItem
                  key={optionMode}
                  value={optionMode}
                  disabled={managedReason !== undefined}
                  className="min-w-64"
                >
                  <div className="grid gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      {option.label}
                    </span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {managedReason ?? option.description}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
      }
    />
  );
}
