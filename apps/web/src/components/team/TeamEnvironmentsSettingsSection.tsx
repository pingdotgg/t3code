import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ALL_TEAM_ROLES,
  canManageTeamEnvironments,
  canMemberAccessTeamEnvironment,
  type EnvironmentId,
  type TeamAccessRule,
  type TeamEnvironment,
  type TeamMember,
  type TeamMemberId,
  type TeamRole,
} from "@t3tools/contracts";
import { readPairingAppLink, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { T, useGT, useMessages } from "gt-react";
import {
  AlertTriangleIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
  UnlinkIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
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

function tryExtractPairingUrl(
  raw: string,
): { readonly url: string; readonly pairingCode: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = readPairingAppLink(trimmed) ?? trimmed;
  if (!candidate.includes("://") && !candidate.includes("token=")) return null;
  try {
    const resolved = resolveRemotePairingTarget({ pairingUrl: candidate });
    return {
      url: resolved.httpBaseUrl.replace(/\/+$/, ""),
      pairingCode: resolved.credential,
    };
  } catch {
    return null;
  }
}

interface EnvAccessDraft {
  readonly environmentId: EnvironmentId;
  readonly isDefault: boolean;
  readonly name: string;
  readonly roles: ReadonlyArray<TeamRole>;
  readonly memberIds: ReadonlyArray<TeamMemberId>;
}

const NEW_PEER_SENTINEL = "__new_peer__";

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
  const messages = useMessages();
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

  const peerLinksQuery = useEnvironmentQuery(
    canManage ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
    messages,
  );
  const attachedEnvironmentIds = new Set(environments.map((env) => env.environmentId));
  const unattachedPeers = (peerLinksQuery.data?.links ?? []).filter(
    (peer) => !attachedEnvironmentIds.has(peer.environmentId),
  );

  const [showAttachForm, setShowAttachForm] = useState(false);
  const [selectedExistingPeerId, setSelectedExistingPeerId] = useState<string>(NEW_PEER_SENTINEL);
  const [attachUrl, setAttachUrl] = useState("");
  const [attachCode, setAttachCode] = useState("");
  const [showAttachCode, setShowAttachCode] = useState(false);
  const [attachName, setAttachName] = useState("");
  const [attachRoles, setAttachRoles] = useState<ReadonlyArray<TeamRole>>([...ALL_TEAM_ROLES]);
  const [attachMemberIds, setAttachMemberIds] = useState<ReadonlyArray<TeamMemberId>>([]);
  const [attaching, setAttaching] = useState(false);

  const [editDraft, setEditDraft] = useState<EnvAccessDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [detachingId, setDetachingId] = useState<EnvironmentId | null>(null);

  const selectedExistingPeer =
    selectedExistingPeerId === NEW_PEER_SENTINEL
      ? null
      : (unattachedPeers.find((peer) => peer.environmentId === selectedExistingPeerId) ?? null);

  const attachWouldLockSelfOut =
    currentMember !== null &&
    !canMemberAccessTeamEnvironment(currentMember, {
      accessRule: { roles: [...attachRoles], memberIds: [...attachMemberIds] },
    });

  const editWouldLockSelfOut =
    currentMember !== null &&
    editDraft !== null &&
    !canMemberAccessTeamEnvironment(currentMember, {
      accessRule: { roles: [...editDraft.roles], memberIds: [...editDraft.memberIds] },
    });

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const applyPairingPasteIfPresent = (value: string, field: "url" | "code") => {
    const parsed = tryExtractPairingUrl(value);
    if (parsed !== null) {
      setAttachUrl(parsed.url);
      setAttachCode(parsed.pairingCode);
      return;
    }
    if (field === "url") {
      setAttachUrl(value);
    } else {
      setAttachCode(value);
    }
  };

  const resetAttachForm = () => {
    setShowAttachForm(false);
    setAttachName("");
    setAttachUrl("");
    setAttachCode("");
    setShowAttachCode(false);
    setAttachRoles([...ALL_TEAM_ROLES]);
    setAttachMemberIds([]);
    setSelectedExistingPeerId(NEW_PEER_SENTINEL);
  };

  const handleAttach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const isExistingPeer = selectedExistingPeer !== null;
    const url = attachUrl.trim();
    const pairingCode = attachCode.trim();
    if (!isExistingPeer && (!url || !pairingCode)) {
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
        ...(isExistingPeer
          ? { environmentId: selectedExistingPeer.environmentId }
          : { url, pairingCode }),
        ...(attachName.trim().length > 0 ? { name: attachName.trim() } : {}),
        accessRule: {
          roles: [...attachRoles],
          memberIds: attachMemberIds.filter((id) => memberById.get(id)?.status !== "removed"),
        },
      },
    });
    setAttaching(false);
    if (result._tag === "Success") {
      resetAttachForm();
      peerLinksQuery.refresh();
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
          memberIds: editDraft.memberIds.filter((id) => memberById.get(id)?.status !== "removed"),
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

  const handleDetach = async (env: TeamEnvironment, unlinkPeer: boolean) => {
    const confirmed = await confirmTeamDestructiveAction(
      unlinkPeer
        ? [
            gt('Detach and unlink "{name}" from this team?', { name: env.name }),
            gt(
              "Team members will lose access to this environment and the Team Server's peer link to it will be removed.",
            ),
          ].join("\n")
        : [
            gt('Detach "{name}" from this team (keep peer link)?', { name: env.name }),
            gt(
              "Team members will lose access to this environment, while keeping the underlying peer link configured on this server.",
            ),
          ].join("\n"),
    );
    if (!confirmed) return;

    setDetachingId(env.environmentId);
    const result = await runDetach({
      environmentId,
      input: { environmentId: env.environmentId, unlinkPeer },
    });
    setDetachingId(null);
    if (result._tag === "Success") {
      peerLinksQuery.refresh();
      toastManager.add({
        type: "success",
        title: unlinkPeer
          ? gt("Environment detached and unlinked")
          : gt("Environment detached (peer link kept)"),
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
            size="xs"
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
                  <div className="flex flex-wrap items-center gap-1.5">
                    {canUpdateScope ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        data-testid={`team-env-edit-${env.environmentId}`}
                        onClick={() => {
                          resetAttachForm();
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
                      <>
                        {env.peerLinkId ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={detachingId === env.environmentId}
                            data-testid={`team-env-detach-keep-peer-${env.environmentId}`}
                            onClick={() => void handleDetach(env, false)}
                          >
                            <UnlinkIcon />
                            <T>Detach only</T>
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={detachingId === env.environmentId}
                          data-testid={`team-env-detach-${env.environmentId}`}
                          onClick={() => void handleDetach(env, true)}
                        >
                          <Trash2Icon />
                          {env.peerLinkId ? <T>Detach &amp; unlink</T> : <T>Detach</T>}
                        </Button>
                      </>
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
            "Attach an already-linked peer environment or link a new remote T3 Code server by URL and pairing code (or paste a full pairing link).",
          )}
        >
          <form
            className="mt-2 space-y-3 pb-3"
            data-testid="team-env-attach-form"
            onSubmit={handleAttach}
          >
            {unattachedPeers.length > 0 ? (
              <div className="space-y-1">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-env-existing-peer"
                >
                  <T>Peer source</T>
                </label>
                <Select
                  value={selectedExistingPeerId}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      setSelectedExistingPeerId(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="team-env-existing-peer"
                    data-testid="team-env-existing-peer-select"
                  >
                    <SelectValue>
                      {selectedExistingPeer
                        ? gt("Linked peer: {label}", { label: selectedExistingPeer.label })
                        : gt("Link a new remote server")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NEW_PEER_SENTINEL}>
                      {gt("Link a new remote server")}
                    </SelectItem>
                    {unattachedPeers.map((peer) => (
                      <SelectItem key={peer.environmentId} value={peer.environmentId}>
                        {gt("Linked peer: {label}", { label: peer.label })}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}

            {selectedExistingPeer === null ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-env-attach-url"
                  >
                    <T>Remote server URL or pairing link</T>
                  </label>
                  <Input
                    id="team-env-attach-url"
                    data-testid="team-env-attach-url"
                    value={attachUrl}
                    onChange={(event) =>
                      applyPairingPasteIfPresent(event.currentTarget.value, "url")
                    }
                    placeholder="https://runner.example.com"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-env-attach-code"
                  >
                    <T>Pairing code</T>
                  </label>
                  <div className="flex items-center gap-1.5">
                    <div className="min-w-0 flex-1">
                      <Input
                        id="team-env-attach-code"
                        data-testid="team-env-attach-code"
                        type={showAttachCode ? "text" : "password"}
                        autoComplete="off"
                        value={attachCode}
                        onChange={(event) =>
                          applyPairingPasteIfPresent(event.currentTarget.value, "code")
                        }
                        placeholder={gt("Pairing code")}
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={
                        showAttachCode ? gt("Hide pairing code") : gt("Reveal pairing code")
                      }
                      data-testid="team-env-attach-code-toggle"
                      onClick={() => setShowAttachCode((visible) => !visible)}
                    >
                      {showAttachCode ? (
                        <EyeOffIcon className="size-3.5" />
                      ) : (
                        <EyeIcon className="size-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-1">
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="team-env-attach-name"
              >
                <T>Display name (optional)</T>
              </label>
              <Input
                id="team-env-attach-name"
                data-testid="team-env-attach-name"
                value={attachName}
                onChange={(event) => setAttachName(event.currentTarget.value)}
                placeholder={selectedExistingPeer?.label ?? gt("e.g. GPU Runner")}
              />
            </div>

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

            {attachWouldLockSelfOut ? (
              <p
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning-foreground"
                role="alert"
                data-testid="team-env-attach-lockout-warning"
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <T>
                    Warning: this access rule excludes your own account. You will not be able to
                    launch threads on this environment until you re-add your role or pseudo.
                  </T>
                </span>
              </p>
            ) : null}

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
              <Button type="button" size="sm" variant="ghost" onClick={resetAttachForm}>
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
            <div className="space-y-1">
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="team-env-edit-name"
              >
                <T>Environment display name</T>
              </label>
              <Input
                id="team-env-edit-name"
                data-testid="team-env-edit-name"
                value={editDraft.name}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setEditDraft((prev) => (prev ? { ...prev, name: value } : null));
                }}
              />
            </div>
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

            {editWouldLockSelfOut ? (
              <p
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning-foreground"
                role="alert"
                data-testid="team-env-edit-lockout-warning"
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <T>
                    Warning: this access rule excludes your own account. You will lose execution
                    access to this environment until you re-add your role or pseudo.
                  </T>
                </span>
              </p>
            ) : null}

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
