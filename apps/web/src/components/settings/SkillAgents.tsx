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
 * The agents that don't load a skill, dimmed; nothing when every enabled agent
 * does. A tight run of icons, so a row stays on one line.
 */
export function SkillAgents({
  value,
  agents,
}: {
  value: SkillAvailability;
  agents: ReadonlyArray<SkillAgent>;
}) {
  if (value.everyone || value.missing.length === 0) return null;
  const label = availabilityNote(value);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="flex shrink-0 items-center gap-1" />}
      >
        {value.missing.map((agent) => (
          <SkillAgentIcon key={agent.instanceId} agent={agent} agents={agents} active={false} />
        ))}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
