import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  extractProjectRepoIdentityKey,
  listAccessibleTeamViews,
  resolveOwningTeamEnvironment,
  resolveProjectTeamAssignment,
} from "@t3tools/client-runtime/team";
import { canManageTeamProjects, type EnvironmentId, type TeamViewId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { UsersIcon } from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import type { SidebarProjectGroupMember } from "~/sidebarProjectGrouping";
import { teamEnvironment, useTeamStatesByEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

const PERSONAL_VALUE = "__personal__";
const TEAM_DEFAULT_VIEW_VALUE = "__team_default__";

export function TeamProjectSettingsSection({
  members,
}: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const gt = useGT();
  const teamStates = useTeamStatesByEnvironment();
  const assignProject = useAtomCommand(teamEnvironment.assignProject, { reportFailure: false });
  const unassignProject = useAtomCommand(teamEnvironment.unassignProject, { reportFailure: false });
  const [saving, setSaving] = useState(false);

  const connectedTeamEnvs = [...teamStates.entries()].filter(
    ([, state]) => state.team !== null && state.currentMember !== null,
  );

  // Find a project checkout that lives on a Team Server or an attached runner (`t3runner`).
  const directTeamMember =
    members.find((member) => teamStates.get(member.environmentId)?.team != null) ?? null;
  const resolvedTeamMemberEntry =
    directTeamMember !== null
      ? {
          member: directTeamMember,
          owning: resolveOwningTeamEnvironment({
            environmentId: directTeamMember.environmentId,
            teamStates,
          })!,
        }
      : (members
          .map((member) => {
            const owning = resolveOwningTeamEnvironment({
              environmentId: member.environmentId,
              teamStates,
            });
            return owning ? { member, owning } : null;
          })
          .find((entry) => entry !== null) ?? null);
  const assignableMember = resolvedTeamMemberEntry?.member ?? null;
  const primaryMember = assignableMember ?? members[0] ?? null;
  const currentAssignment =
    members
      .map((member) =>
        resolveProjectTeamAssignment({
          project: {
            id: member.id,
            environmentId: member.environmentId,
            repositoryIdentity: member.repositoryIdentity,
          },
          teamStates,
        }),
      )
      .find((entry) => entry !== null) ?? null;

  const targetTeamEnvId: EnvironmentId | null =
    currentAssignment?.teamEnvironmentId ??
    resolvedTeamMemberEntry?.owning.teamEnvironmentId ??
    null;
  const targetTeamState = targetTeamEnvId ? (teamStates.get(targetTeamEnvId) ?? null) : null;
  const canAssignScope = useAtomValue(
    teamEnvironment.assignProject.permissionAtom(targetTeamEnvId),
  );
  const canUnassignScope = useAtomValue(
    teamEnvironment.unassignProject.permissionAtom(targetTeamEnvId),
  );
  if (connectedTeamEnvs.length === 0 || primaryMember === null) {
    return null;
  }
  const canManage =
    assignableMember !== null &&
    targetTeamEnvId !== null &&
    targetTeamState?.currentMember != null &&
    targetTeamState.currentMember.status === "active" &&
    canManageTeamProjects(targetTeamState.currentMember.role) &&
    canAssignScope &&
    canUnassignScope;

  const repoKey =
    extractProjectRepoIdentityKey(primaryMember.repositoryIdentity) ??
    currentAssignment?.assignment.repoIdentityKey ??
    null;
  const accessibleViews = currentAssignment
    ? listAccessibleTeamViews(currentAssignment.teamState)
    : [];
  const selectedTeamValue = currentAssignment
    ? currentAssignment.teamEnvironmentId
    : PERSONAL_VALUE;
  const selectedDefaultViewValue =
    currentAssignment?.assignment.defaultViewId ?? TEAM_DEFAULT_VIEW_VALUE;

  const handleTeamChange = async (value: string | null) => {
    if (!value || !assignableMember) return;
    setSaving(true);
    if (value === PERSONAL_VALUE) {
      if (currentAssignment) {
        const result = await unassignProject({
          environmentId: currentAssignment.teamEnvironmentId,
          input: { projectId: currentAssignment.assignment.projectId },
        });
        setSaving(false);
        if (result._tag === "Success") {
          toastManager.add({ type: "success", title: gt("Project removed from team") });
        } else if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: gt("Could not update team project"),
            description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
          });
        }
        return;
      }
      setSaving(false);
      return;
    }
    const envId = value as EnvironmentId;
    const result = await assignProject({
      environmentId: envId,
      input: {
        projectId: assignableMember.id,
        defaultViewId: null,
        ...(repoKey !== null ? { repoIdentityKey: repoKey } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: gt("Project assigned to team") });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not assign project to team"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    }
  };

  const handleDefaultViewChange = async (value: string | null) => {
    if (!value || !currentAssignment || !assignableMember) return;
    setSaving(true);
    const nextViewId = value === TEAM_DEFAULT_VIEW_VALUE ? null : (value as TeamViewId);
    const result = await assignProject({
      environmentId: currentAssignment.teamEnvironmentId,
      input: {
        projectId: currentAssignment.assignment.projectId,
        defaultViewId: nextViewId,
        ...(repoKey !== null ? { repoIdentityKey: repoKey } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: gt("Default team view updated") });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not update default view"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    }
  };

  return (
    <SettingsSection id="project-team" title={gt("Team")} icon={<UsersIcon className="size-4" />}>
      <SettingsRow
        title={gt("Team workspace")}
        description={
          currentAssignment
            ? repoKey
              ? gt("Shared with {teamName}. Clones matching {repoKey} sync automatically.", {
                  teamName: currentAssignment.team.name,
                  repoKey,
                })
              : gt("Shared with {teamName}.", { teamName: currentAssignment.team.name })
            : gt("Assign this project to a team to enable shared environments and local sync.")
        }
        control={
          canManage ? (
            <Select
              value={selectedTeamValue}
              disabled={saving}
              onValueChange={(value) => void handleTeamChange(value)}
            >
              <SelectTrigger size="sm" data-testid="project-team-select">
                <SelectValue>
                  {currentAssignment ? currentAssignment.team.name : gt("Personal (none)")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={PERSONAL_VALUE}>
                  <T>Personal (none)</T>
                </SelectItem>
                {targetTeamEnvId && targetTeamState?.team ? (
                  <SelectItem value={targetTeamEnvId}>{targetTeamState.team.name}</SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
          ) : (
            <Badge variant={currentAssignment ? "secondary" : "outline"} size="sm">
              {currentAssignment ? currentAssignment.team.name : gt("Personal")}
            </Badge>
          )
        }
      />

      {currentAssignment ? (
        <SettingsRow
          title={gt("Default team view")}
          description={gt(
            "New threads created in this project default to this team view unless overridden.",
          )}
          control={
            canManage ? (
              <Select
                value={selectedDefaultViewValue}
                disabled={saving}
                onValueChange={(value) => void handleDefaultViewChange(value)}
              >
                <SelectTrigger size="sm" data-testid="project-team-default-view-select">
                  <SelectValue>
                    {currentAssignment.assignment.defaultViewId
                      ? (accessibleViews.find(
                          (view) => view.id === currentAssignment.assignment.defaultViewId,
                        )?.name ?? gt("Team default"))
                      : gt("Team default")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={TEAM_DEFAULT_VIEW_VALUE}>
                    <T>Team default</T>
                  </SelectItem>
                  {accessibleViews.map((view) => (
                    <SelectItem key={view.id} value={view.id}>
                      {view.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <Badge variant="outline" size="sm">
                {currentAssignment.assignment.defaultViewId
                  ? (accessibleViews.find(
                      (view) => view.id === currentAssignment.assignment.defaultViewId,
                    )?.name ?? gt("Team default"))
                  : gt("Team default")}
              </Badge>
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
