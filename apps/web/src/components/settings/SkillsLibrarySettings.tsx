import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { SkillsLibraryIssuesDialog } from "./SkillsLibraryIssuesDialog";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { T, useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
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
        label={environment.label}
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
  const gt = useGT();
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
  const [showIssues, setShowIssues] = useState(false);
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

  const setting = useSearchableSetting();
  const searchable = setting("skills-library");
  const conflicts = status.data?.conflicts.length ?? 0;
  const mismatches = status.data?.nameMismatches.length ?? 0;
  const issueSummary = [
    conflicts > 0
      ? gt("{count, plural, one {{count} conflict} other {{count} conflicts}}", {
          count: conflicts,
        })
      : null,
    mismatches > 0
      ? gt("{count, plural, one {{count} name mismatch} other {{count} name mismatches}}", {
          count: mismatches,
        })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const title = label ? gt("Skills library on {label}", { label }) : searchable.title;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["skillsLibraryEnabled"]}
      {...(isSearchTarget ? { id: searchable.id } : {})}
      title={title}
      description={gt(
        "Share skills across providers and accounts on this environment. Turning it off restores separate skill folders.",
      )}
      status={
        <>
          {issueSummary ? (
            <Button size="xs" variant="outline" onClick={() => setShowIssues(true)}>
              {gt("Review {issueSummary}", { issueSummary })}
            </Button>
          ) : null}
          {showIssues && status.data ? (
            <SkillsLibraryIssuesDialog
              status={status.data}
              environmentLabel={label ?? gt("This environment")}
              onClose={() => setShowIssues(false)}
            />
          ) : null}
        </>
      }
      resetAction={
        enabled !== DEFAULT_UNIFIED_SETTINGS.skillsLibraryEnabled ? (
          <SettingResetButton
            ariaLabel={gt("Reset skills library to default")}
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
              <T>Refresh</T>
            </Button>
          ) : null}
          <ScopedSwitch
            settingKeys={["skillsLibraryEnabled"]}
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ skillsLibraryEnabled: Boolean(checked) })
            }
            aria-label={title}
          />
        </>
      }
    />
  );
}
