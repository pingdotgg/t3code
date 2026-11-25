import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { T, useGT, useMessages } from "gt-react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useManagedPolicy } from "../../state/managedPolicy";
import { ClaudeProjectHookList, useClaudeProjectHooks } from "../ClaudeProjectHooks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The hooks each checkout's Claude Code settings declare, and whether Claude threads run them. */
export function ProjectClaudeHooksSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  return checkouts.map((member) => (
    <CheckoutClaudeHooks
      key={member.physicalProjectKey}
      member={member}
      showCheckout={checkouts.length > 1}
    />
  ));
}

function CheckoutClaudeHooks({
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
  const policyDenial = managedCapabilityDenial(
    useManagedPolicy(environmentId),
    "claudeProjectHooks",
    m,
  );
  const { query, canApprove, saving, save } = useClaudeProjectHooks({
    environmentId,
    projectId: member.id,
  });
  const shown = query.data;
  // Most projects declare none, and then there is nothing to show; a failed read shows nothing either.
  if (shown === null || shown.status === "none") return null;
  const approved = shown.status === "approved";

  return (
    <SettingsSection id="project-claude-hooks" title={gt("Claude hooks")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {policyDenial ?? (
          <T>
            This project's Claude Code settings run their own commands in Claude threads. They run
            on this environment's machine with your permissions. Below Full access they run only as
            approved here, and hooks that change need approval again. Threads in Full access run
            them without asking.
          </T>
        )}
        {showCheckout ? (
          <span className="mt-1 block truncate">
            {member.environmentLabel ?? gt("Environment")} · {member.workspaceRoot}
          </span>
        ) : null}
      </p>
      <SettingsRow
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">
              <T>Hooks from this project's folder</T>
            </span>
            {policyDenial !== undefined ? (
              <Badge size="sm" variant="outline">
                <T>Off</T>
              </Badge>
            ) : approved ? (
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
        description={gt("An approval takes effect when the next Claude session starts.")}
        control={
          <Button
            size="xs"
            variant={approved ? "ghost" : "outline"}
            disabled={
              !canApprove ||
              !isConnected ||
              saving ||
              query.isPending ||
              (!approved && policyDenial !== undefined)
            }
            onClick={() => void save(!approved)}
          >
            {approved ? <T>Revoke</T> : <T>Approve</T>}
          </Button>
        }
      >
        <div className="mb-2">
          <ClaudeProjectHookList hooks={shown.hooks} />
        </div>
      </SettingsRow>
      {!canApprove ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <T>This connection cannot approve hooks. Use a client that can use the terminal.</T>
        </p>
      ) : null}
    </SettingsSection>
  );
}
