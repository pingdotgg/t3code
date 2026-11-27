import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  projectScopeMenuGroups,
  selectProjectAxis,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";
import { useRenderedSettingsPathname } from "./useRenderedSettingsPathname";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

interface ScopeChoice {
  label: string;
  secondary?: readonly string[];
  icon: ReactNode;
  search: SettingsScopeSearch;
}

export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
  inline = false,
}: {
  children: string;
  /** Renders inside a section instead of as its own page. */
  inline?: boolean;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const gt = useGT();
  const { selectScope, search, groups } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useRenderedSettingsPathname();
  const { environments } = useEnvironments();
  const environmentIcon = (environment: EnvironmentPresentation | undefined) =>
    environment ? (
      <EnvironmentMachineIcon
        aria-hidden
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        className="size-4 shrink-0 text-muted-foreground"
      />
    ) : null;
  const choiceGroups =
    target === "checkout"
      ? groups.filter((group) => !search.project || group.projectKey === search.project)
      : [null];
  const projectGroups = projectScopeMenuGroups(groups, search);
  const renderChoices = (group: SidebarProjectSnapshot | null) => {
    const choices: ScopeChoice[] = group
      ? group.memberProjects.map((member) => {
          const environment = environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          const { primary, secondary } = environment
            ? settingsScopeEnvironmentLabels(environment, environments)
            : {
                primary: member.environmentLabel ?? gt("Environment"),
                secondary: member.environmentId,
              };
          return {
            label: primary,
            secondary: [member.workspaceRoot, secondary].filter(Boolean),
            icon: environmentIcon(environment),
            search: {
              project: group.projectKey,
              machine: member.environmentId,
              checkout: member.physicalProjectKey,
            },
          };
        })
      : target === "project"
        ? projectGroups.map((group) => ({
            label: group.displayName,
            secondary: [
              ...(group.archived ? [gt("Archived", { $context: "project state" })] : []),
              ...(projectGroups.some(
                (other) =>
                  other.projectKey !== group.projectKey && other.displayName === group.displayName,
              )
                ? settingsScopeProjectMachines(group, environments).flatMap(
                    ({ primary, secondary }) => [primary, secondary].filter(Boolean),
                  )
                : []),
              group.workspaceRoot,
            ].filter(Boolean),
            icon: <ProjectFavicon project={group} className="size-4 shrink-0" />,
            search: selectProjectAxis(search, group.projectKey),
          }))
        : target === "environment"
          ? environments
              .filter(
                (entry) =>
                  eligibleEnvironmentIds === undefined ||
                  eligibleEnvironmentIds.includes(entry.environmentId),
              )
              .map((entry) => {
                const { primary, secondary } = settingsScopeEnvironmentLabels(entry, environments);
                return {
                  label: primary,
                  secondary: [secondary || settingsScopeEnvironmentAddress(entry)],
                  icon: environmentIcon(entry),
                  search: { machine: entry.environmentId },
                };
              })
          : [
              {
                label: gt("Open all environments"),
                icon: <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
                search: {},
              },
            ];
    return choices.map((choice) => (
      <div key={JSON.stringify(choice.search)} className={ITEM_ROW_CLASSNAME}>
        <Button
          size="sm-multiline"
          variant="secondary"
          className="w-full"
          onClick={() => {
            if (targetId)
              void navigate({
                to: pathname,
                search: () => ({
                  project: undefined,
                  machine: undefined,
                  checkout: undefined,
                  ...choice.search,
                }),
                hash: targetId,
              });
            else selectScope(choice.search);
          }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-3 text-left">
            {choice.icon}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label">{choice.label}</span>
              {choice.secondary?.length ? (
                <span className="flex min-w-0 flex-col text-meta text-muted-foreground">
                  {choice.secondary.map((detail) => (
                    <SharedTooltipTrigger
                      key={detail}
                      render={<span className="block truncate" />}
                      label={detail}
                    >
                      {detail}
                    </SharedTooltipTrigger>
                  ))}
                </span>
              ) : null}
            </span>
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </span>
        </Button>
      </div>
    ));
  };
  const notice = (
    <div className="space-y-3">
      <p role="status" className="px-3 text-body text-muted-foreground sm:px-4">
        {children}
      </p>
      <div className="space-y-4">
        {choiceGroups.map((group) =>
          group?.displayName ? (
            <SettingsSection key={group.projectKey} title={group.displayName}>
              {renderChoices(group)}
            </SettingsSection>
          ) : (
            <SettingsGroup key={group?.projectKey ?? target}>{renderChoices(group)}</SettingsGroup>
          ),
        )}
      </div>
    </div>
  );
  return inline ? notice : <SettingsPageContainer>{notice}</SettingsPageContainer>;
}
