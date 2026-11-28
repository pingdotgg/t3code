import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  assignableTeamRoles,
  canManageTeamMembers,
  canModifyTeamMember,
  type EnvironmentId,
  type TeamMember,
  type TeamMemberId,
  type TeamMemberStatus,
  type TeamRole,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ShieldIcon } from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
import { formatTeamRoleLabel } from "./TeamJoinForm";

export function TeamMembersSettingsSection({
  environmentId,
  currentMember,
  members,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly members: ReadonlyArray<TeamMember>;
}) {
  const gt = useGT();
  const canUpdateRoleScope = useAtomValue(
    teamEnvironment.updateMemberRole.permissionAtom(environmentId),
  );
  const canUpdateStatusScope = useAtomValue(
    teamEnvironment.updateMemberStatus.permissionAtom(environmentId),
  );
  const runUpdateMemberRole = useAtomCommand(teamEnvironment.updateMemberRole, {
    reportFailure: false,
  });
  const runUpdateMemberStatus = useAtomCommand(teamEnvironment.updateMemberStatus, {
    reportFailure: false,
  });

  const [busyMemberId, setBusyMemberId] = useState<TeamMemberId | null>(null);

  const activeOwnerCount = members.filter(
    (member) => member.status === "active" && member.role === "owner",
  ).length;
  const actorCanManage =
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamMembers(currentMember.role);
  const actorAssignableRoles = currentMember ? assignableTeamRoles(currentMember.role) : [];

  const handleRoleChange = async (member: TeamMember, nextRole: TeamRole) => {
    if (member.role === nextRole) return;
    setBusyMemberId(member.id);
    const result = await runUpdateMemberRole({
      environmentId,
      input: { memberId: member.id, role: nextRole },
    });
    setBusyMemberId((active) => (active === member.id ? null : active));
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Member role updated"),
        description: gt("{pseudo} is now {role}.", {
          pseudo: result.value.pseudo,
          role: formatTeamRoleLabel(result.value.role, gt),
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not update member role"),
        description: thrownErrorMessage(error, m) ?? gt("Could not update member role"),
      });
    }
  };

  const handleStatusChange = async (member: TeamMember, nextStatus: TeamMemberStatus) => {
    if (member.status === nextStatus) return;
    if (nextStatus === "removed") {
      const confirmMessage = [
        gt('Remove "{pseudo}" from the team?', { pseudo: member.pseudo }),
        gt("This revokes all their sessions. Removed members cannot be reactivated."),
      ].join("\n");
      const confirmed = await confirmTeamDestructiveAction(confirmMessage);
      if (!confirmed) return;
    }
    setBusyMemberId(member.id);
    const result = await runUpdateMemberStatus({
      environmentId,
      input: { memberId: member.id, status: nextStatus },
    });
    setBusyMemberId((active) => (active === member.id ? null : active));
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title:
          nextStatus === "active"
            ? gt("Member reactivated")
            : nextStatus === "suspended"
              ? gt("Member suspended")
              : gt("Member removed"),
        description: result.value.pseudo,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not update member status"),
        description: thrownErrorMessage(error, m) ?? gt("Could not update member status"),
      });
    }
  };

  return (
    <SettingsSection
      id="teams-members"
      title={gt("Members")}
      icon={<ShieldIcon className="size-4" />}
    >
      <div className="divide-y divide-border/60">
        {members.map((member) => {
          const isSelf = currentMember?.id === member.id;
          const isLastActiveOwner =
            member.status === "active" && member.role === "owner" && activeOwnerCount <= 1;
          const actorCanEditTarget =
            actorCanManage &&
            currentMember !== null &&
            canModifyTeamMember(currentMember.role, member.role);
          const canEditRole =
            actorCanEditTarget &&
            canUpdateRoleScope &&
            member.status === "active" &&
            !isLastActiveOwner;
          const canEditStatus =
            actorCanEditTarget && canUpdateStatusScope && !isSelf && !isLastActiveOwner;
          const isBusy = busyMemberId === member.id;

          return (
            <div
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 sm:px-4"
              data-testid={`team-member-${member.pseudo}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {member.pseudo}
                </span>
                {isSelf ? (
                  <Badge variant="outline" size="sm">
                    <T>You</T>
                  </Badge>
                ) : null}
                {member.status !== "active" ? (
                  <Badge variant="error" size="sm">
                    {member.status === "suspended" ? <T>Suspended</T> : <T>Removed</T>}
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canEditRole ? (
                  <Select
                    value={member.role}
                    disabled={isBusy}
                    onValueChange={(value) => {
                      if (typeof value === "string") {
                        void handleRoleChange(member, value as TeamRole);
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      data-testid={`team-member-role-select-${member.pseudo}`}
                      aria-label={gt("Role for {pseudo}", { pseudo: member.pseudo })}
                    >
                      <SelectValue>{formatTeamRoleLabel(member.role, gt)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      {actorAssignableRoles.map((role) => (
                        <SelectItem
                          key={role}
                          value={role}
                          data-testid={`team-member-role-option-${member.pseudo}-${role}`}
                        >
                          {formatTeamRoleLabel(role, gt)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <Badge variant="secondary" size="sm">
                    {formatTeamRoleLabel(member.role, gt)}
                  </Badge>
                )}

                {canEditStatus && member.status !== "removed" ? (
                  member.status === "active" ? (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isBusy}
                        data-testid={`team-member-suspend-${member.pseudo}`}
                        onClick={() => void handleStatusChange(member, "suspended")}
                      >
                        <T>Suspend</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={isBusy}
                        data-testid={`team-member-remove-${member.pseudo}`}
                        onClick={() => void handleStatusChange(member, "removed")}
                      >
                        <T>Remove</T>
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isBusy}
                        data-testid={`team-member-reactivate-${member.pseudo}`}
                        onClick={() => void handleStatusChange(member, "active")}
                      >
                        <T>Reactivate</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={isBusy}
                        data-testid={`team-member-remove-${member.pseudo}`}
                        onClick={() => void handleStatusChange(member, "removed")}
                      >
                        <T>Remove</T>
                      </Button>
                    </>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}
