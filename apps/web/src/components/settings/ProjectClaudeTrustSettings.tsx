import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { T, useGT, useMessages } from "gt-react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useManagedPolicy } from "../../state/managedPolicy";
import { ClaudeProjectCommandList, useClaudeProjectTrust } from "../ClaudeProjectTrust";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Whether each checkout's Claude Code settings are trusted, and what they would run. */
export function ProjectClaudeTrustSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  return checkouts.map((member) => (
    <CheckoutClaudeTrust
      key={member.physicalProjectKey}
      member={member}
      showCheckout={checkouts.length > 1}
    />
  ));
}

function CheckoutClaudeTrust({
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
  const { query, canTrust, saving, save } = useClaudeProjectTrust({
    environmentId,
    projectId: member.id,
  });
  const shown = query.data;
  // Most projects have nothing to trust, and then there is nothing to show; a failed read shows nothing either.
  if (shown === null || (shown.status !== "trusted" && shown.commands.length === 0)) return null;
  const trusted = shown.status === "trusted";

  return (
    <SettingsSection id="project-claude-trust" title={gt("Claude Code settings")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {policyDenial ?? (
          <T>
            A trusted project runs everything its Claude Code settings name in Claude threads:
            hooks, helper commands, MCP servers and environment variables, on this environment's
            machine with your permissions. Until you trust it, threads below Full access run without
            them. Threads in Full access run them without asking.
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
              <T>This project's Claude Code settings</T>
            </span>
            {policyDenial !== undefined ? (
              <Badge size="sm" variant="outline">
                <T>Off</T>
              </Badge>
            ) : trusted ? (
              <Badge size="sm" variant="success">
                <T context="state of a project">Trusted</T>
              </Badge>
            ) : (
              <Badge size="sm" variant="warning">
                <T>Not trusted</T>
              </Badge>
            )}
          </span>
        }
        description={gt("A change takes effect when the next Claude session starts.")}
        control={
          policyDenial !== undefined ? null : (
            <Button
              size="xs"
              variant={trusted ? "ghost" : "outline"}
              disabled={!canTrust || !isConnected || saving || query.isPending}
              onClick={() => void save(!trusted)}
            >
              {trusted ? <T>Revoke</T> : <T context="verb, button that trusts a project">Trust</T>}
            </Button>
          )
        }
      >
        {shown.commands.length === 0 ? null : (
          <div className="my-2">
            <ClaudeProjectCommandList commands={shown.commands} />
          </div>
        )}
      </SettingsRow>
      {!canTrust ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <T>This connection cannot trust a project. Use a client that can use the terminal.</T>
        </p>
      ) : null}
    </SettingsSection>
  );
}
