import type { AgentContextRecord, EnvironmentId } from "@t3tools/contracts";
import { agentReferenceState } from "@t3tools/shared/composerContextReferences";
import { BotIcon } from "lucide-react";

import { useAgentProfiles } from "~/state/agentProfiles";
import { useEnvironmentIdentities } from "~/state/environments";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Inline chip for a mentioned agent, in the composer and in sent messages. Resolves by
 * profileId, so a renamed agent shows its current name and a deleted one its snapshot.
 */
export function AgentContextChip(props: {
  record: Pick<AgentContextRecord, "profileId" | "name">;
  environmentId?: EnvironmentId | null | undefined;
  copyMarkdown?: string;
}) {
  const profiles = useAgentProfiles();
  const identities = useEnvironmentIdentities();
  const state = agentReferenceState(props.record, profiles, props.environmentId ?? undefined);
  const machines =
    state.status === "elsewhere"
      ? state.environmentIds
          .map((id) => identities.find((identity) => identity.environmentId === id)?.label ?? id)
          .join(", ")
      : "";
  const detail = {
    available: "T3 agent",
    missing: "This agent was deleted or isn't on this machine",
    "read-only": "Read-only agent: it can't run work",
    elsewhere: `Agent runs only on ${machines}`,
  }[state.status];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="agent"
            {...(state.status === "missing" ? { state: "unresolved" as const } : {})}
            tabIndex={0}
            aria-label={`Agent, ${state.name}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <BotIcon />
            <ContextChipLabel>{state.name}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{detail}</TooltipPopup>
    </Tooltip>
  );
}
