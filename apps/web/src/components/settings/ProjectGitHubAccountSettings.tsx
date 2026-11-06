import type { SourceControlProviderAuth } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { groupHostAccounts } from "./SourceControlAccountSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Inherit the environment host pin / active gh login. */
const ENVIRONMENT_DEFAULT = "environment default";

export function ProjectGitHubAccountSettings() {
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["githubHostAccounts"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const discovery = useEnvironmentQuery(
    environmentId === null || !isProjectScope
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const github = discovery.data?.sourceControlProviders.find((item) => item.kind === "github");
  const auth: SourceControlProviderAuth | undefined = github?.auth;
  const groups = groupHostAccounts(auth?.accounts ?? []).filter(
    (group) => group.selectable.length > 1 || settings.githubHostAccounts[group.host] !== undefined,
  );

  if (!isProjectScope || groups.length === 0) return null;

  const accounts = mixed ? {} : settings.githubHostAccounts;
  const hasOverride = Object.keys(accounts).length > 0;

  return (
    <>
      {groups.map((group) => {
        const pinned = accounts[group.host];
        const stale =
          pinned !== undefined && !group.selectable.includes(pinned) ? pinned : undefined;
        const value = stale !== undefined ? stale : (pinned ?? ENVIRONMENT_DEFAULT);
        return (
          <SettingsRow
            key={group.host}
            serverScoped
            settingKeys={["githubHostAccounts"]}
            mixed={mixed}
            {...searchableSetting("project-github-account")}
            title={`GitHub account · ${group.host}`}
            description="Pull requests and agent GitHub CLI calls for this project use this login. Inherit uses the environment choice in Source control."
            resetAction={
              hasOverride ? (
                <SettingResetButton
                  label="GitHub account"
                  tooltip="Inherit the environment GitHub account"
                  onClick={() => updateSettings({ githubHostAccounts: {} })}
                />
              ) : null
            }
            control={
              <div className="w-64 max-w-full">
                <Select
                  value={mixed ? null : value}
                  onValueChange={(next) => {
                    if (typeof next !== "string") return;
                    const rest = Object.fromEntries(
                      Object.entries(accounts).filter(([host]) => host !== group.host),
                    );
                    updateSettings({
                      githubHostAccounts:
                        next === ENVIRONMENT_DEFAULT ? rest : { ...rest, [group.host]: next },
                    });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`GitHub account for ${group.host}`}>
                    <SelectValue>
                      {(selected: string) =>
                        selected === ENVIRONMENT_DEFAULT
                          ? "Environment default"
                          : selected === stale
                            ? `${selected} (signed out)`
                            : selected
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={ENVIRONMENT_DEFAULT}>Environment default</SelectItem>
                    {group.selectable.map((account) => (
                      <SelectItem key={account} value={account}>
                        {account}
                        {group.activeAccount === account ? " (active gh)" : ""}
                      </SelectItem>
                    ))}
                    {stale !== undefined ? (
                      <SelectItem value={stale}>{stale} (signed out)</SelectItem>
                    ) : null}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
        );
      })}
    </>
  );
}
