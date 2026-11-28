import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type WorktreeLayoutCommand,
  type WorktreeLayoutCommandKind,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useManagedPolicy } from "../../state/managedPolicy";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { WORKTREE_LAYOUT_COMMAND_LABELS } from "../WorktreeLayoutApprovalDialogHost";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const COMMAND_TITLES: Record<WorktreeLayoutCommandKind, string> = {
  create: msg("Create command"),
  remove: msg("Remove command"),
};

/** The `worktreeLayout` commands each checkout's `t3.json` declares, and whether they may run. */
export function ProjectWorktreeLayoutSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  return checkouts.map((member) => (
    <CheckoutWorktreeLayout
      key={member.physicalProjectKey}
      member={member}
      showCheckout={checkouts.length > 1}
    />
  ));
}

function CheckoutWorktreeLayout({
  member,
  showCheckout,
}: {
  member: SidebarProjectGroupMember;
  showCheckout: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = member.environmentId;
  const { environments } = useEnvironments();
  const isConnected =
    environments.find((entry) => entry.environmentId === environmentId)?.connection.phase ===
    "connected";
  const access = useFilesystemReadAccess(environmentId);
  const canApprove = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const policyDenial = managedCapabilityDenial(
    useManagedPolicy(environmentId),
    "worktreeLayoutCommands",
    m,
  );
  const query = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.layoutCommands({ environmentId, input: { projectId: member.id } })
      : null,
  );
  const approve = useAtomCommand(filesystemEnvironment.approveLayoutCommands, {
    reportFailure: false,
  });
  const [savingKind, setSavingKind] = useState<WorktreeLayoutCommandKind | null>(null);
  const commands = query.data?.commands ?? [];
  // A failed first read is not a project without commands.
  if (query.data === null && query.error !== null) {
    return (
      <SettingsSection id="project-worktree-layout" title={gt("Worktree layout")}>
        <SettingsRow
          title={gt("Could not load the worktree layout commands")}
          description={query.error}
          control={
            <Button size="xs" variant="outline" onClick={query.refresh}>
              <T>Retry</T>
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  // Most projects declare none, and then there is nothing to show.
  if (commands.length === 0) return null;

  // Approving sends the text on screen, so a file that changed since is not approved unseen.
  const save = async (command: WorktreeLayoutCommand, approved: boolean) => {
    setSavingKind(command.kind);
    const result = await approve({
      environmentId,
      input: {
        projectId: member.id,
        approvals: [{ kind: command.kind, command: approved ? command.command : null }],
      },
    });
    setSavingKind(null);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: approved ? gt("Could not approve the command") : gt("Could not revoke the approval"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
    query.refresh();
  };

  return (
    <SettingsSection id="project-worktree-layout" title={gt("Worktree layout")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {policyDenial ?? (
          <T>
            This project's <code>t3.json</code> sets up worktree threads with its own commands. They
            run on this environment's machine with your permissions, and only as approved here: a
            command whose text changes needs approval again.
          </T>
        )}
        {showCheckout ? (
          <span className="mt-1 block truncate">
            {member.environmentLabel ?? gt("Environment")} · {member.workspaceRoot}
          </span>
        ) : null}
      </p>
      {commands.map((command) => (
        <SettingsRow
          key={command.kind}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">{m(COMMAND_TITLES[command.kind])}</span>
              {policyDenial !== undefined ? (
                <Badge size="sm" variant="outline">
                  <T>Off</T>
                </Badge>
              ) : command.approved ? (
                <Badge size="sm" variant="success">
                  <T>Approved</T>
                </Badge>
              ) : (
                <Badge size="sm" variant="warning">
                  <T>Needs approval</T>
                </Badge>
              )}
            </span>
          }
          description={m(WORKTREE_LAYOUT_COMMAND_LABELS[command.kind])}
          control={
            <Button
              size="xs"
              variant={command.approved ? "ghost" : "outline"}
              disabled={
                !canApprove ||
                !isConnected ||
                savingKind !== null ||
                query.isPending ||
                (!command.approved && policyDenial !== undefined)
              }
              aria-label={
                command.approved
                  ? gt("Revoke approval of the {kind} command", { kind: command.kind })
                  : gt("Approve the {kind} command", { kind: command.kind })
              }
              onClick={() => void save(command, !command.approved)}
            >
              {command.approved ? <T>Revoke</T> : <T>Approve</T>}
            </Button>
          }
        >
          <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
            {command.command}
          </pre>
        </SettingsRow>
      ))}
      {!canApprove ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <T>This connection cannot approve commands. Use a client that can use the terminal.</T>
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-warning-foreground sm:px-4">
          {query.error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
