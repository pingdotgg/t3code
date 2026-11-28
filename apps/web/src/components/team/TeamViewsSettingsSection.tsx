import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ALL_TEAM_ROLES,
  canManageTeamViews,
  isTeamAdminRole,
  type EnvironmentId,
  type TeamAccessRule,
  type TeamMember,
  type TeamMemberId,
  type TeamRole,
  type TeamView,
  type TeamViewId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { LayersIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
import { formatTeamRoleLabel } from "./TeamJoinForm";

interface ViewEditorDraft {
  readonly mode: "create" | "edit";
  readonly viewId: TeamViewId | null;
  readonly isDefault: boolean;
  readonly name: string;
  readonly description: string;
  readonly readRoles: ReadonlyArray<TeamRole>;
  readonly readMemberIds: ReadonlyArray<TeamMemberId>;
  readonly postRoles: ReadonlyArray<TeamRole>;
  readonly postMemberIds: ReadonlyArray<TeamMemberId>;
}

function makeEmptyCreateDraft(): ViewEditorDraft {
  return {
    mode: "create",
    viewId: null,
    isDefault: false,
    name: "",
    description: "",
    readRoles: [...ALL_TEAM_ROLES],
    readMemberIds: [],
    postRoles: [...ALL_TEAM_ROLES],
    postMemberIds: [],
  };
}

function makeEditDraft(view: TeamView): ViewEditorDraft {
  return {
    mode: "edit",
    viewId: view.id,
    isDefault: view.isDefault,
    name: view.name,
    description: view.description ?? "",
    readRoles: [...view.readRule.roles],
    readMemberIds: [...view.readRule.memberIds],
    postRoles: [...view.postRule.roles],
    postMemberIds: [...view.postRule.memberIds],
  };
}

function toggleItem<T>(list: ReadonlyArray<T>, item: T, checked: boolean): ReadonlyArray<T> {
  if (checked) {
    return list.includes(item) ? list : [...list, item];
  }
  return list.filter((existing) => existing !== item);
}

function formatRuleSummary(
  rule: TeamAccessRule,
  kind: "read" | "post",
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
    return kind === "read" ? gt("Owners & admins only") : gt("Thread creator only");
  }
  return parts.join(" · ");
}

export function TeamViewsSettingsSection({
  environmentId,
  currentMember,
  members,
  memberById,
  views,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly members: ReadonlyArray<TeamMember>;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly views: ReadonlyArray<TeamView>;
}) {
  const gt = useGT();
  const canCreateViewScope = useAtomValue(teamEnvironment.createView.permissionAtom(environmentId));
  const canUpdateViewScope = useAtomValue(teamEnvironment.updateView.permissionAtom(environmentId));
  const canDeleteViewScope = useAtomValue(teamEnvironment.deleteView.permissionAtom(environmentId));
  const runCreateView = useAtomCommand(teamEnvironment.createView, { reportFailure: false });
  const runUpdateView = useAtomCommand(teamEnvironment.updateView, { reportFailure: false });
  const runDeleteView = useAtomCommand(teamEnvironment.deleteView, { reportFailure: false });

  const [draft, setDraft] = useState<ViewEditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingViewId, setDeletingViewId] = useState<TeamViewId | null>(null);

  const actorCanManage =
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamViews(currentMember.role);
  const activeMembers = members.filter((member) => member.status === "active");
  const nonAdminActiveMembers = activeMembers.filter((member) => !isTeamAdminRole(member.role));

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    const trimmedName = draft.name.trim();
    if (trimmedName.length === 0) {
      toastManager.add({
        type: "error",
        title: gt("View name is required"),
      });
      return;
    }
    const trimmedDescription = draft.description.trim();
    const readRule: TeamAccessRule = {
      roles: draft.isDefault ? [...ALL_TEAM_ROLES] : [...draft.readRoles],
      memberIds: draft.isDefault
        ? []
        : draft.readMemberIds.filter((id) => memberById.get(id)?.status !== "removed"),
    };
    const postRule: TeamAccessRule = {
      roles: [...draft.postRoles],
      memberIds: draft.postMemberIds.filter((id) => memberById.get(id)?.status !== "removed"),
    };

    setSaving(true);
    const result =
      draft.mode === "create"
        ? await runCreateView({
            environmentId,
            input: {
              name: trimmedName,
              ...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
              readRule,
              postRule,
            },
          })
        : await runUpdateView({
            environmentId,
            input: {
              viewId: draft.viewId!,
              name: trimmedName,
              description: trimmedDescription.length > 0 ? trimmedDescription : null,
              ...(draft.isDefault ? {} : { readRule }),
              postRule,
            },
          });
    setSaving(false);

    if (result._tag === "Success") {
      setDraft(null);
      toastManager.add({
        type: "success",
        title: draft.mode === "create" ? gt("View created") : gt("View updated"),
        description: result.value.name,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: draft.mode === "create" ? gt("Could not create view") : gt("Could not update view"),
        description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
      });
    }
  };

  const handleDelete = async (view: TeamView) => {
    const confirmMessage = [
      gt('Delete view "{viewName}"?', { viewName: view.name }),
      gt("Threads in this view will be moved to the Default view."),
    ].join("\n");
    const confirmed = await confirmTeamDestructiveAction(confirmMessage);
    if (!confirmed) return;
    setDeletingViewId(view.id);
    const result = await runDeleteView({
      environmentId,
      input: { viewId: view.id },
    });
    setDeletingViewId((active) => (active === view.id ? null : active));
    if (result._tag === "Success") {
      if (draft?.viewId === view.id) {
        setDraft(null);
      }
      toastManager.add({
        type: "success",
        title: gt("View deleted"),
        description: gt("Threads in {viewName} were moved to Default.", {
          viewName: view.name,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not delete view"),
        description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
      });
    }
  };

  return (
    <SettingsSection
      id="teams-views"
      title={gt("Views")}
      icon={<LayersIcon className="size-4" />}
      headerAction={
        actorCanManage && canCreateViewScope && draft === null ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="team-view-create-open"
            onClick={() => setDraft(makeEmptyCreateDraft())}
          >
            <PlusIcon />
            <T>New view</T>
          </Button>
        ) : undefined
      }
    >
      <div data-testid="team-views-section">
        {draft !== null ? (
          <SettingsRow
            title={draft.mode === "create" ? gt("Create view") : gt("Edit view")}
            description={
              draft.isDefault
                ? gt(
                    "The Default view is always readable by all roles. You can customize who can post in colleagues' threads.",
                  )
                : gt(
                    "Control which roles or specific members can read and post in threads assigned to this view.",
                  )
            }
          >
            <form
              className="mt-3 space-y-4 pb-3"
              data-testid="team-view-form"
              onSubmit={(event) => void handleSave(event)}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-view-name"
                  >
                    <T>View name</T>
                  </label>
                  <Input
                    id="team-view-name"
                    data-testid="team-view-name-input"
                    value={draft.name}
                    onChange={(event) => {
                      const nextName = event.currentTarget.value;
                      setDraft((current) => (current ? { ...current, name: nextName } : null));
                    }}
                    placeholder={gt("e.g. Announcements")}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-view-description"
                  >
                    <T>Description (optional)</T>
                  </label>
                  <Input
                    id="team-view-description"
                    data-testid="team-view-description-input"
                    value={draft.description}
                    onChange={(event) => {
                      const nextDescription = event.currentTarget.value;
                      setDraft((current) =>
                        current ? { ...current, description: nextDescription } : null,
                      );
                    }}
                    placeholder={gt("e.g. Visible to everyone, posting restricted to staff")}
                    disabled={saving}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <p className="text-xs font-medium text-foreground">
                    <T>Who can read</T>
                  </p>
                  <div className="space-y-1.5">
                    {ALL_TEAM_ROLES.map((role) => {
                      const isAlwaysReadableRole = role === "owner" || role === "admin";
                      const checked =
                        draft.isDefault || isAlwaysReadableRole || draft.readRoles.includes(role);
                      return (
                        <label
                          key={role}
                          className="flex items-center gap-2 text-xs text-foreground"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={saving || draft.isDefault || isAlwaysReadableRole}
                            data-testid={`team-view-read-role-${role}`}
                            onCheckedChange={(nextChecked) => {
                              const isChecked = nextChecked === true;
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      readRoles: toggleItem(current.readRoles, role, isChecked),
                                    }
                                  : null,
                              );
                            }}
                          />
                          <span>{formatTeamRoleLabel(role, gt)}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    <T>Owners and admins can always read all views.</T>
                  </p>
                  {!draft.isDefault && nonAdminActiveMembers.length > 0 ? (
                    <div className="border-t border-border/50 pt-2">
                      <p className="mb-1.5 text-2xs text-muted-foreground">
                        <T>Specific members</T>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {nonAdminActiveMembers.map((member) => {
                          const checked = draft.readMemberIds.includes(member.id);
                          return (
                            <label
                              key={member.id}
                              className="flex items-center gap-1.5 text-xs text-foreground"
                            >
                              <Checkbox
                                checked={checked}
                                disabled={saving}
                                data-testid={`team-view-read-member-${member.pseudo}`}
                                onCheckedChange={(nextChecked) => {
                                  const isChecked = nextChecked === true;
                                  setDraft((current) =>
                                    current
                                      ? {
                                          ...current,
                                          readMemberIds: toggleItem(
                                            current.readMemberIds,
                                            member.id,
                                            isChecked,
                                          ),
                                        }
                                      : null,
                                  );
                                }}
                              />
                              <span>{member.pseudo}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <p className="text-xs font-medium text-foreground">
                    <T>Who can post in colleagues' threads</T>
                  </p>
                  <div className="space-y-1.5">
                    {ALL_TEAM_ROLES.map((role) => {
                      const checked = draft.postRoles.includes(role);
                      return (
                        <label
                          key={role}
                          className="flex items-center gap-2 text-xs text-foreground"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={saving}
                            data-testid={`team-view-post-role-${role}`}
                            onCheckedChange={(nextChecked) => {
                              const isChecked = nextChecked === true;
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      postRoles: toggleItem(current.postRoles, role, isChecked),
                                    }
                                  : null,
                              );
                            }}
                          />
                          <span>{formatTeamRoleLabel(role, gt)}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    <T>Thread creators can always post in their own unlocked threads.</T>
                  </p>
                  {activeMembers.length > 0 ? (
                    <div className="border-t border-border/50 pt-2">
                      <p className="mb-1.5 text-2xs text-muted-foreground">
                        <T>Specific members</T>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {activeMembers.map((member) => {
                          const checked = draft.postMemberIds.includes(member.id);
                          return (
                            <label
                              key={member.id}
                              className="flex items-center gap-1.5 text-xs text-foreground"
                            >
                              <Checkbox
                                checked={checked}
                                disabled={saving}
                                data-testid={`team-view-post-member-${member.pseudo}`}
                                onCheckedChange={(nextChecked) => {
                                  const isChecked = nextChecked === true;
                                  setDraft((current) =>
                                    current
                                      ? {
                                          ...current,
                                          postMemberIds: toggleItem(
                                            current.postMemberIds,
                                            member.id,
                                            isChecked,
                                          ),
                                        }
                                      : null,
                                  );
                                }}
                              />
                              <span>{member.pseudo}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  data-testid="team-view-cancel"
                  onClick={() => setDraft(null)}
                >
                  <T>Cancel</T>
                </Button>
                <Button type="submit" size="sm" disabled={saving} data-testid="team-view-save">
                  {saving ? <Spinner /> : null}
                  {draft.mode === "create" ? <T>Create view</T> : <T>Save view</T>}
                </Button>
              </div>
            </form>
          </SettingsRow>
        ) : null}

        <div className="divide-y divide-border/60">
          {views.map((view) => {
            const isDeleting = deletingViewId === view.id;
            return (
              <div
                key={view.id}
                className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 sm:px-4"
                data-testid={`team-view-row-${view.name}`}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {view.name}
                    </span>
                    {view.isDefault ? (
                      <Badge variant="outline" size="sm">
                        <T>Default</T>
                      </Badge>
                    ) : null}
                  </div>
                  {view.description ? (
                    <p className="text-xs text-muted-foreground">{view.description}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      {gt("Read: {summary}", {
                        summary: formatRuleSummary(view.readRule, "read", memberById, gt),
                      })}
                    </span>
                    <span>
                      {gt("Post: {summary}", {
                        summary: formatRuleSummary(view.postRule, "post", memberById, gt),
                      })}
                    </span>
                  </div>
                </div>

                {actorCanManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {canUpdateViewScope ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={isDeleting}
                        data-testid={`team-view-edit-${view.name}`}
                        onClick={() => setDraft(makeEditDraft(view))}
                      >
                        <PencilIcon />
                        <T>Edit</T>
                      </Button>
                    ) : null}
                    {!view.isDefault && canDeleteViewScope ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={isDeleting}
                        data-testid={`team-view-delete-${view.name}`}
                        onClick={() => void handleDelete(view)}
                      >
                        <Trash2Icon />
                        <T>Delete</T>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}
