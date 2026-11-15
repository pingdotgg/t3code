import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolvePastedPath } from "@t3tools/shared/path";

import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NewProjectsSettingsSection() {
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
    <SettingsSection id="new-projects" title="New projects">
      {supportsNewProjectsDirectory ? (
        <SettingsRow
          serverScoped
          settingKeys={["newProjectsDirectory"]}
          {...searchableSetting("new-projects-directory")}
          description="Folder where New project creates repositories, such as ~/repos. Existing projects stay where they are. Leave empty to use the projects folder in the T3 home."
          resetAction={
            mixedNewProjectsDirectory ||
            settings.newProjectsDirectory !== DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory ? (
              <SettingResetButton
                label="new projects directory"
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
              placeholder={mixedNewProjectsDirectory ? "Mixed" : "~/.t3/projects"}
              spellCheck={false}
              aria-label="New projects directory"
            />
          }
        />
      ) : null}
      <SettingsRow
        serverScoped
        settingKeys={["addProjectBaseDirectory"]}
        {...searchableSetting("add-project-starts-in")}
        description='Leave empty to use "~/" when the Add Project browser opens.'
        resetAction={
          settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
            <SettingResetButton
              label="add project base directory"
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
            placeholder={mixedAddProjectBaseDirectory ? "Mixed" : "~/"}
            spellCheck={false}
            aria-label="Add project base directory"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["ghqCloneLayout"]}
        {...searchableSetting("ghq-clone-layout")}
        description="Clones go to github.com/owner/repo under the folder above, like ghq."
        resetAction={
          settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout ? (
            <SettingResetButton
              label="clone into host folders"
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
            aria-label="Clone into host folders"
          />
        }
      />
    </SettingsSection>
  );
}
