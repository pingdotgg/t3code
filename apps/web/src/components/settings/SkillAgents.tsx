import { SparklesIcon } from "lucide-react";

import { shouldShowInstanceBadge } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { availabilityNote, type SkillAgent, type SkillAvailability } from "./toolsSettings.logic";

/** An agent's icon. Instances that share a driver carry a badge, so they can be told apart. */
export function SkillAgentIcon({
  agent,
  agents,
  active = true,
}: {
  agent: SkillAgent;
  /** Every agent on the page, to know whether this one shares its driver with another. */
  agents: ReadonlyArray<SkillAgent>;
  active?: boolean;
}) {
  return (
    <span className={active ? undefined : "opacity-30 grayscale"}>
      <ProviderInstanceIcon
        driverKind={agent.driverKind}
        displayName={agent.displayName}
        accentColor={agent.accentColor}
        showBadge={shouldShowInstanceBadge(agent, agents)}
        iconClassName="size-4"
      />
    </span>
  );
}

/**
 * Who loads a skill: one mark when every enabled agent does, otherwise the
 * agents that do. A tight run of icons, so a row stays on one line.
 */
export function SkillAgents({
  value,
  agents,
}: {
  value: SkillAvailability;
  agents: ReadonlyArray<SkillAgent>;
}) {
  const label = availabilityNote(value);
  if (!value.everyone && value.agents.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="flex shrink-0 items-center gap-1" />}
      >
        {value.everyone ? (
          <SparklesIcon className="size-4 text-muted-foreground" />
        ) : (
          value.agents.map((agent) => (
            <SkillAgentIcon key={agent.instanceId} agent={agent} agents={agents} />
          ))
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
