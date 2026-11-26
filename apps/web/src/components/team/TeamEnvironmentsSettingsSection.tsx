import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ALL_TEAM_ROLES,
  canManageTeamEnvironments,
  type EnvironmentId,
  type TeamAccessRule,
  type TeamEnvironment,
  type TeamMember,
  type TeamMemberId,
  type TeamRole,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PencilIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { formatTeamRoleLabel } from "./TeamJoinForm";

function toggleItem<T>(list: ReadonlyArray<T>, item: T, checked: boolean): ReadonlyArray<T> {
  if (checked) {
    return list.includes(item) ? list : [...list, item];
  }
  return list.filter((existing) => existing !== item);
}

function formatEnvRuleSummary(
  rule: TeamAccessRule,
  memberById: ReadonlyMap<TeamMemberId, TeamMember>,
  gt: ReturnType<typeof useGT>,
): string {
  const parts: string[] = [];
  if (rule.roles.length === ALL_TEAM_ROLES.length) {
    parts.push(gt("All roles"));
  } else if (rule.roles.length > 0) {
    parts.push(rule.roles.map((role) => formatTeamRoleLabel(role, gt)).join(", "));
  }
  if (rule.memberIds.length > 0) {
    const names = rule.memberIds.map((id) => memberById.get(id)?.pseudo ?? id);
    parts.push(names.join(", "));
  }
  if (parts.length === 0) {
    return gt("No members (restricted)");
  }
  return parts.join(" · ");
}

interface EnvAccessDraft {
  readonly environmentId: EnvironmentId;
  readonly isDefault: boolean;
  readonly name: string;
  readonly roles: ReadonlyArray<TeamRole>;
  readonly memberIds: ReadonlyArray<TeamMemberId>;
}

export function TeamEnvironmentsSettingsSection({
  environmentId,
  currentMember,
  members,
  memberById,
  environments,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly members: ReadonlyArray<TeamMember>;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly environments: ReadonlyArray<TeamEnvironment>;
}) {
  const gt = useGT();
  const canAttachScope = useAtomValue(
    teamEnvironment.attachEnvironment.permissionAtom(environmentId),
  );
  const canUpdateScope = useAtomValue(
    teamEnvironment.updateEnvironment.permissionAtom(environmentId),
  );
  const canDetachScope = useAtomValue(
    teamEnvironment.detachEnvironment.permissionAtom(environmentId),
  );
  const runAttach = useAtomCommand(teamEnvironment.attachEnvironment, { reportFailure: false });
  const runUpdate = useAtomCommand(teamEnvironment.updateEnvironment, { reportFailure: false });
  const runDetach = useAtomCommand(teamEnvironment.detachEnvironment, { reportFailure: false });

  const canManage =
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamEnvironments(currentMember.role);
  const activeMembers = members.filter((member) => member.status === "active");

  const [showAttachForm, setShowAttachForm] = useState(false);
  const [attachUrl, setAttachUrl] = useState("");
  const [attachCode, setAttachCode] = useState("");
  const [attachName, setAttachName] = useState("");
  const [attachRoles, setAttachRoles] = useState<ReadonlyArray<TeamRole>>([...ALL_TEAM_ROLES]);
  const [attachMemberIds, setAttachMemberIds] = useState<ReadonlyArray<TeamMemberId>>([]);
  const [attaching, setAttaching] = useState(false);

  const [editDraft, setEditDraft] = useState<EnvAccessDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [detachingId, setDetachingId] = useState<EnvironmentId | null>(null);

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const handleAttach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = attachUrl.trim();
    const pairingCode = attachCode.trim();
    if (!url || !pairingCode) {
      reportError(
        gt("Could not attach environment"),
        new Error(gt("Enter both the remote server URL and pairing code.")),
      );
      return;
    }
    setAttaching(true);
    const result = await runAttach({
      environmentId,
      input: {
        url,
        pairingCode,
        ...(attachName.trim().length > 0 ? { name: attachName.trim() } : {}),
        accessRule: {
          roles: [...attachRoles],
          memberIds: [...attachMemberIds],
        },
      },
    });
    setAttaching(false);
    if (result._tag === "Success") {
      setShowAttachForm(false);
      setAttachUrl("");
      setAttachCode("");
      setAttachName("");
      setAttachRoles([...ALL_TEAM_ROLES]);
      setAttachMemberIds([]);
      toastManager.add({
        type: "success",
        title: gt("Remote environment attached"),
        description: result.value.name,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not attach environment"), squashAtomCommandFailure(result));
    }
  };

  const handleSaveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editDraft) return;
    setSavingEdit(true);
    const result = await runUpdate({
      environmentId,
      input: {
        environmentId: editDraft.environmentId,
        ...(editDraft.name.trim().length > 0 ? { name: editDraft.name.trim() } : {}),
        accessRule: {
          roles: [...editDraft.roles],
          memberIds: [...editDraft.memberIds],
        },
      },
    });
    setSavingEdit(false);
    if (result._tag === "Success") {
      setEditDraft(null);
      toastManager.add({
        type: "success",
        title: gt("Environment access updated"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not update environment"), squashAtomCommandFailure(result));
    }
  };

  const handleDetach = async (targetEnvironmentId: EnvironmentId) => {
    setDetachingId(targetEnvironmentId);
    const result = await runDetach({
      environmentId,
      input: { environmentId: targetEnvironmentId },
    });
    setDetachingId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Environment detached"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not detach environment"), squashAtomCommandFailure(result));
    }
  };

  return (
    <SettingsSection
      id="teams-environments"
      title={gt("Environments")}
      icon={<ServerIcon className="size-4" />}
      headerAction={
        canManage && canAttachScope && !showAttachForm ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="team-env-attach-open"
            onClick={() => {
              setEditDraft(null);
              setShowAttachForm(true);
            }}
          >
            <PlusIcon />
            <T>Attach environment</T>
          </Button>
        ) : undefined
      }
    >
      <SettingsRow
        title={gt("Team execution environments")}
        description={gt(
          "Configure who can launch and execute threads on the default team server and any attached remote environments.",
        )}
      >
        <div className="mt-2 space-y-2 pb-3" data-testid="team-environments-list">
          {environments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>No environments are accessible to your role.</T>
            </p>
          ) : (
            environments.map((env) => (
              <div
                key={env.environmentId}
                data-testid={`team-env-row-${env.environmentId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{env.name}</span>
                    {env.isDefault ? (
                      <Badge variant="secondary" size="sm">
                        <T>Default</T>
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground">
                    {gt("Access: {summary}", {
                      summary: formatEnvRuleSummary(env.accessRule, memberById, gt),
                    })}
                  </p>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1.5">
                    {canUpdateScope ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        data-testid={`team-env-edit-${env.environmentId}`}
                        onClick={() => {
                          setShowAttachForm(false);
                          setEditDraft({
                            environmentId: env.environmentId,
                            isDefault: env.isDefault,
                            name: env.name,
                            roles: [...env.accessRule.roles],
                            memberIds: [...env.accessRule.memberIds],
                          });
                        }}
                      >
                        <PencilIcon />
                        <T>Edit</T>
                      </Button>
                    ) : null}
                    {!env.isDefault && canDetachScope ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={detachingId === env.environmentId}
                        data-testid={`team-env-detach-${env.environmentId}`}
                        onClick={() => void handleDetach(env.environmentId)}
                      >
                        <Trash2Icon />
                        <T>Detach</T>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </SettingsRow>

      {showAttachForm && canManage ? (
        <SettingsRow
          title={gt("Attach remote environment")}
          description={gt(
            "Link a remote T3 Code server by URL and pairing code, then choose which team roles or members may run threads on it.",
          )}
        >
          <form
            className="mt-2 space-y-3 pb-3"
            data-testid="team-env-attach-form"
            onSubmit={handleAttach}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                data-testid="team-env-attach-url"
                value={attachUrl}
                onChange={(event) => setAttachUrl(event.currentTarget.value)}
                placeholder="https://runner.example.com"
                aria-label={gt("Remote server URL")}
              />
              <Input
                data-testid="team-env-attach-code"
                value={attachCode}
                onChange={(event) => setAttachCode(event.currentTarget.value)}
                placeholder={gt("Pairing code")}
                aria-label={gt("Pairing code")}
              />
            </div>
            <Input
              data-testid="team-env-attach-name"
              value={attachName}
              onChange={(event) => setAttachName(event.currentTarget.value)}
              placeholder={gt("Display name (optional)")}
              aria-label={gt("Display name")}
            />
            <div className="space-y-2 rounded-lg border border-border/60 p-3">
              <p className="text-xs font-medium text-foreground">
                <T>Allowed roles</T>
              </p>
              <div className="flex flex-wrap gap-3">
                {ALL_TEAM_ROLES.map((role) => (
                  <label key={role} className="inline-flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={attachRoles.includes(role)}
                      onCheckedChange={(checked) =>
                        setAttachRoles((prev) => toggleItem(prev, role, Boolean(checked)))
                      }
                    />
                    <span>{formatTeamRoleLabel(role, gt)}</span>
                  </label>
                ))}
              </div>
              {activeMembers.length > 0 ? (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs font-medium text-foreground">
                    <T>Additional allowed members</T>
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {activeMembers.map((member) => (
                      <label key={member.id} className="inline-flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={attachMemberIds.includes(member.id)}
                          onCheckedChange={(checked) =>
                            setAttachMemberIds((prev) =>
                              toggleItem(prev, member.id, Boolean(checked)),
                            )
                          }
                        />
                        <span>{member.pseudo}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={attaching}
                data-testid="team-env-attach-submit"
              >
                {attaching ? <Spinner size="xs" /> : null}
                <T>Attach</T>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowAttachForm(false)}
              >
                <T>Cancel</T>
              </Button>
            </div>
          </form>
        </SettingsRow>
      ) : null}

      {editDraft && canManage ? (
        <SettingsRow
          title={gt("Edit environment access")}
          description={gt(
            "Update the display name and execution permissions for this environment.",
          )}
        >
          <form
            className="mt-2 space-y-3 pb-3"
            data-testid="team-env-edit-form"
            onSubmit={handleSaveEdit}
          >
            <Input
              data-testid="team-env-edit-name"
              value={editDraft.name}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setEditDraft((prev) => (prev ? { ...prev, name: value } : null));
              }}
              aria-label={gt("Environment display name")}
            />
            <div className="space-y-2 rounded-lg border border-border/60 p-3">
              <p className="text-xs font-medium text-foreground">
                <T>Allowed roles</T>
              </p>
              <div className="flex flex-wrap gap-3">
                {ALL_TEAM_ROLES.map((role) => (
                  <label key={role} className="inline-flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={editDraft.roles.includes(role)}
                      onCheckedChange={(checked) =>
                        setEditDraft((prev) =>
                          prev
                            ? { ...prev, roles: toggleItem(prev.roles, role, Boolean(checked)) }
                            : null,
                        )
                      }
                    />
                    <span>{formatTeamRoleLabel(role, gt)}</span>
                  </label>
                ))}
              </div>
              {activeMembers.length > 0 ? (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs font-medium text-foreground">
                    <T>Additional allowed members</T>
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {activeMembers.map((member) => (
                      <label key={member.id} className="inline-flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={editDraft.memberIds.includes(member.id)}
                          onCheckedChange={(checked) =>
                            setEditDraft((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    memberIds: toggleItem(
                                      prev.memberIds,
                                      member.id,
                                      Boolean(checked),
                                    ),
                                  }
                                : null,
                            )
                          }
                        />
                        <span>{member.pseudo}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={savingEdit}
                data-testid="team-env-edit-save"
              >
                {savingEdit ? <Spinner size="xs" /> : null}
                <T>Save</T>
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditDraft(null)}>
                <T>Cancel</T>
              </Button>
            </div>
          </form>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
