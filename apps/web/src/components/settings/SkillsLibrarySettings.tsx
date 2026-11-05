import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Status and refresh belong to one environment, so each gets its own row, narrowed the way the
 * single-environment settings pages are.
 */
export function SkillsLibraryRows() {
  const { search, connectedEnvironments, selectScope } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.skillsLibrary === true,
  );
  return supported.map((environment, index) => (
    <SettingsScopeProvider
      key={environment.environmentId}
      search={{ ...search, machine: environment.environmentId }}
      singleEnvironment
      onChange={selectScope}
    >
      <SkillsLibraryRow
        environmentId={environment.environmentId}
        label={supported.length > 1 ? environment.label : null}
        isSearchTarget={index === 0}
      />
    </SettingsScopeProvider>
  ));
}

function SkillsLibraryRow({
  environmentId,
  label,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly isSearchTarget: boolean;
}) {
  const enabled = useScopedSettings((settings) => settings.skillsLibraryEnabled);
  const updateSettings = useUpdateScopedSettings();
  const canRefresh = useAtomValue(
    serverEnvironment.refreshSkillsLibrary.permissionAtom(environmentId),
  );
  const refreshLibrary = useAtomCommand(serverEnvironment.refreshSkillsLibrary);
  const status = useEnvironmentQuery(
    serverEnvironment.skillsLibraryStatus({ environmentId, input: {} }),
  );
  const refreshStatus = status.refresh;
  const [refreshing, setRefreshing] = useState(false);
  const statusEnabled = useRef(enabled);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server moves skill folders when the switch changes; re-read them
  useEffect(() => {
    if (statusEnabled.current === enabled) return;
    statusEnabled.current = enabled;
    refreshStatus();
  }, [enabled, refreshStatus]);

  const refresh = async () => {
    setRefreshing(true);
    await refreshLibrary({ environmentId, input: {} });
    setRefreshing(false);
    refreshStatus();
  };

  const searchable = searchableSetting("skills-library");
  const conflicts = status.data?.conflicts ?? [];
  const mismatches = status.data?.nameMismatches ?? [];
  return (
    <SettingsRow
      serverScoped
      settingKeys={["skillsLibraryEnabled"]}
      {...(isSearchTarget ? { id: searchable.id } : {})}
      title={label ? `${searchable.title} on ${label}` : searchable.title}
      description="Keeps your skills in ~/.agents/skills and links them into Claude's and Antigravity's skill folders, so every harness and every account sees the same set. Codex, Cursor, OpenCode and the others read that folder directly."
      status={
        conflicts.length > 0 || mismatches.length > 0 ? (
          <ul className="space-y-1">
            {conflicts.map((conflict) => (
              <li key={conflict.name}>
                <span className="font-medium text-foreground">{conflict.name}</span>{" "}
                {conflict.reason === "outsideLink" ? (
                  <>
                    in {conflict.paths[0]} has a link outside the skill at {conflict.paths[1]},
                    which moving it would break. Replace the link with the file to link it.
                  </>
                ) : (
                  <>
                    differs between {conflict.paths[0]} and {conflict.paths[1]}. Keep one copy to
                    link it.
                  </>
                )}
              </li>
            ))}
            {mismatches.map((mismatch) => (
              <li key={mismatch.name}>
                <span className="font-medium text-foreground">{mismatch.name}</span> is named "
                {mismatch.frontmatterName}" in its SKILL.md. Some harnesses use the folder name,
                others the frontmatter name.
              </li>
            ))}
          </ul>
        ) : null
      }
      resetAction={
        enabled !== DEFAULT_UNIFIED_SETTINGS.skillsLibraryEnabled ? (
          <SettingResetButton
            label="skills library"
            onClick={() =>
              updateSettings({
                skillsLibraryEnabled: DEFAULT_UNIFIED_SETTINGS.skillsLibraryEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <>
          {enabled && canRefresh ? (
            <Button
              size="xs"
              variant="outline"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          ) : null}
          <ScopedSwitch
            settingKeys={["skillsLibraryEnabled"]}
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ skillsLibraryEnabled: Boolean(checked) })
            }
            aria-label={label ? `Skills library on ${label}` : "Skills library"}
          />
        </>
      }
    />
  );
}
