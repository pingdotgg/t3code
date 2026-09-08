import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments } from "../../state/environments";
import type { SettingsScopeSearch } from "./settingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

/** Offer an explicit target change when a category has no settings at this scope. */
export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "device" | "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const groups = useSettingsProjectGroups();
  const choices: { label: string; search: SettingsScopeSearch }[] =
    target === "checkout"
      ? groups
          .filter((group) => !search.project || group.projectKey === search.project)
          .flatMap((group) =>
            group.memberProjects.map((member) => ({
              label: `${group.displayName} · ${member.environmentLabel ?? "Environment"} · ${member.workspaceRoot}`,
              search: {
                project: group.projectKey,
                machine: member.environmentId,
                checkout: member.physicalProjectKey,
              },
            })),
          )
      : target === "project"
        ? groups.map((group) => ({
            label: group.displayName,
            search: { project: group.projectKey },
          }))
        : target === "environment"
          ? environments
              .filter(
                (entry) =>
                  eligibleEnvironmentIds === undefined ||
                  eligibleEnvironmentIds.includes(entry.environmentId),
              )
              .map((entry) => ({
                label: environments.some(
                  (other) =>
                    other.environmentId !== entry.environmentId && other.label === entry.label,
                )
                  ? `${entry.label} · ${entry.displayUrl || entry.environmentId}`
                  : entry.label,
                search: { machine: entry.environmentId },
              }))
          : [
              {
                label:
                  target === "device" ? "Open settings for this device" : "Open all environments",
                search: { scope: target },
              },
            ];
  return (
    <SettingsPageContainer>
      <Alert role="status">
        <AlertDescription>
          <p>{children}</p>
          <AlertAction className="flex-wrap gap-2">
            {choices.map((choice) => (
              <Button
                key={JSON.stringify(choice.search)}
                size="sm-multiline"
                variant="outline"
                className="max-w-full break-all text-left"
                onClick={() => {
                  if (targetId)
                    void navigate({ to: pathname, search: () => choice.search, hash: targetId });
                  else selectScope(choice.search);
                }}
              >
                {choice.label}
              </Button>
            ))}
          </AlertAction>
        </AlertDescription>
      </Alert>
    </SettingsPageContainer>
  );
}
