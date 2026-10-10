import { SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { shouldShowInstanceBadge } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  availabilityNote,
  type Availability,
  type SkillAgent,
  type SkillsContext,
} from "./SkillsSettings.logic";

/** An agent's icon. Instances that share a driver carry a badge, so they can be told apart. */
export function SkillAgentIcon({
  agent,
  agents,
  active = true,
  size = "sm",
}: {
  agent: SkillAgent;
  /** Every agent on the page, to know whether this one shares its driver with another. */
  agents: readonly SkillAgent[];
  active?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span data-agent={agent.instanceId} className={active ? undefined : "opacity-30 grayscale"}>
      <ProviderInstanceIcon
        driverKind={agent.driverKind}
        displayName={agent.displayName}
        accentColor={agent.accentColor}
        showBadge={shouldShowInstanceBadge(agent, agents)}
        iconClassName={size === "sm" ? "size-4" : "size-5"}
      />
    </span>
  );
}

/** A tight, never-wrapping run of icons, so a row stays on one line. */
function IconRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="flex shrink-0 items-center gap-1" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Who has a skill, or a group of them, on: one mark when every installed agent does, otherwise just
 * the agents that do, and nothing when none does. Agents that aren't installed and enabled never
 * show.
 */
export function SkillAgents({ value, ctx }: { value: Availability; ctx: SkillsContext }) {
  const label = availabilityNote(value);
  if (value.everyone)
    return (
      <IconRow label={label}>
        <SparklesIcon className="size-4 text-muted-foreground" />
      </IconRow>
    );
  if (value.agents.length === 0) return null;
  return (
    <IconRow label={label}>
      {value.agents.map((agent) => (
        <SkillAgentIcon key={agent.instanceId} agent={agent} agents={ctx.installed} />
      ))}
    </IconRow>
  );
}
