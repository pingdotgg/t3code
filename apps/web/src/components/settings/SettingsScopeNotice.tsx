import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";

interface ScopeChoice {
  label: string;
  secondary?: string;
  icon: ReactNode;
  search: SettingsScopeSearch;
}

export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search, groups } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
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
  const renderChoices = (group: SidebarProjectSnapshot | null) => {
    const choices: ScopeChoice[] = group
      ? group.memberProjects.map((member) => {
          const environment = environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          const { primary, secondary } = environment
            ? settingsScopeEnvironmentLabels(environment, environments)
            : {
                primary: member.environmentLabel ?? "Environment",
                secondary: member.environmentId,
              };
          return {
            label: primary,
            secondary: [secondary, member.workspaceRoot].filter(Boolean).join(" · "),
            icon: environmentIcon(environment),
            search: {
              project: group.projectKey,
              machine: member.environmentId,
              checkout: member.physicalProjectKey,
            },
          };
        })
      : target === "project"
        ? groups.map((group) => ({
            label: group.displayName,
            secondary: [
              ...(groups.some(
                (other) =>
                  other.projectKey !== group.projectKey && other.displayName === group.displayName,
              )
                ? settingsScopeProjectMachines(group, environments)
                : []),
              group.workspaceRoot,
            ].join(" · "),
            icon: <ProjectFavicon project={group} className="size-4 shrink-0" />,
            search: { project: group.projectKey },
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
                  secondary: secondary || settingsScopeEnvironmentAddress(entry),
                  icon: environmentIcon(entry),
                  search: { machine: entry.environmentId },
                };
              })
          : [
              {
                label: "Open all environments",
                icon: <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
                search: {},
              },
            ];
    return choices.map((choice) => (
      <button
        key={JSON.stringify(choice.search)}
        type="button"
        className={cn(
          ITEM_ROW_CLASSNAME,
          "flex w-full min-w-0 cursor-pointer items-center gap-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        onClick={() => {
          if (targetId)
            void navigate({ to: pathname, search: () => choice.search, hash: targetId });
          else selectScope(choice.search);
        }}
      >
        {choice.icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{choice.label}</span>
          {choice.secondary ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="block truncate text-xs text-muted-foreground" />}
              >
                {choice.secondary}
              </TooltipTrigger>
              <TooltipPopup>{choice.secondary}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
    ));
  };
  return (
    <SettingsPageContainer>
      <div className="space-y-3">
        <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
          {children}
        </p>
        <div className="space-y-4">
          {choiceGroups.map((group) =>
            group?.displayName ? (
              <SettingsSection key={group.projectKey} title={group.displayName}>
                {renderChoices(group)}
              </SettingsSection>
            ) : (
              <SettingsGroup key={group?.projectKey ?? target}>
                {renderChoices(group)}
              </SettingsGroup>
            ),
          )}
        </div>
      </div>
    </SettingsPageContainer>
  );
}
