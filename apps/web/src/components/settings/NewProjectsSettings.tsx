import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useGT } from "gt-react";

import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NewProjectsSettingsSection() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedNewProjectsDirectory = useScopedSettingsMixed(["newProjectsDirectory"]);
  const supportsNewProjectsDirectory = connectedEnvironments.every(
    (environment) =>
      environment.serverConfig?.environment.capabilities.newProjectsDirectory === true,
  );

  return (
    <SettingsSection id="new-projects" title={gt("New projects")}>
      {supportsNewProjectsDirectory ? (
        <SettingsRow
          serverScoped
          settingKeys={["newProjectsDirectory"]}
          {...setting("new-projects-directory")}
          description={gt(
            "Folder where New project creates repositories, such as ~/repos. Existing projects stay where they are. Leave empty to use the projects folder in the T3 home.",
          )}
          resetAction={
            mixedNewProjectsDirectory ||
            settings.newProjectsDirectory !== DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory ? (
              <SettingResetButton
                ariaLabel={gt("Reset new projects directory to default")}
                onClick={() =>
                  updateSettings({
                    newProjectsDirectory: DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedNewProjectsDirectory ? "" : settings.newProjectsDirectory}
              onCommit={(next) => updateSettings({ newProjectsDirectory: next })}
              normalizeDraft={resolvePastedPath}
              placeholder={mixedNewProjectsDirectory ? gt("Mixed") : "~/.t3/projects"}
              spellCheck={false}
              aria-label={gt("New projects directory")}
            />
          }
        />
      ) : null}
      <SettingsRow
        serverScoped
        settingKeys={["addProjectBaseDirectory"]}
        {...setting("add-project-starts-in")}
        description={gt('Leave empty to use "~/" when the Add Project browser opens.')}
        resetAction={
          settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
            <SettingResetButton
              ariaLabel={gt("Reset add project base directory to default")}
              onClick={() =>
                updateSettings({
                  addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
            onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
            normalizeDraft={resolvePastedPath}
            placeholder={mixedAddProjectBaseDirectory ? gt("Mixed") : "~/"}
            spellCheck={false}
            aria-label={gt("Add project base directory")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["ghqCloneLayout"]}
        {...setting("ghq-clone-layout")}
        description={gt("Clones go to github.com/owner/repo under the folder above, like ghq.")}
        resetAction={
          settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout ? (
            <SettingResetButton
              ariaLabel={gt("Reset clone into host folders to default")}
              onClick={() =>
                updateSettings({ ghqCloneLayout: DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["ghqCloneLayout"]}
            checked={settings.ghqCloneLayout}
            onCheckedChange={(checked) => updateSettings({ ghqCloneLayout: Boolean(checked) })}
            aria-label={gt("Clone into host folders")}
          />
        }
      />
    </SettingsSection>
  );
}
