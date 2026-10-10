import type { ReactNode } from "react";

import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SkillAgentIcon } from "./skillAgentIcon";
import {
  hasAccess,
  switchBlocker,
  type Skill,
  type SkillAgent,
  type SkillsContext,
} from "./SkillsSettings.logic";

/**
 * One agent and its own switch. A switch that can't be flipped is disabled and says why when the
 * chip is pointed at; `blocker` is that reason, or null when the switch works.
 */
export function AgentChip({
  agent,
  agents,
  on,
  blocker,
  disabled,
  onToggle,
}: {
  agent: SkillAgent;
  /** Every agent on the page, to tell instances of one driver apart. */
  agents: readonly SkillAgent[];
  on: boolean;
  blocker: ReactNode;
  /** Nothing can be switched now, such as while a change is being made. */
  disabled: boolean;
  onToggle: () => void;
}) {
  const chip = (
    <>
      <SkillAgentIcon agent={agent} agents={agents} active={on} />
      {agent.displayName}
      <Switch
        size="sm"
        aria-label={agent.displayName}
        checked={on}
        disabled={disabled || !!blocker}
        onCheckedChange={onToggle}
      />
    </>
  );
  const className =
    "flex items-center gap-2 rounded-lg border border-border/60 bg-card py-1.5 pr-2 pl-2.5 text-sm sm:text-xs";
  return blocker ? (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={className} />}>{chip}</TooltipTrigger>
      <TooltipPopup>{blocker}</TooltipPopup>
    </Tooltip>
  ) : (
    <span className={className}>{chip}</span>
  );
}

/** An agent's switch for one skill. An agent T3 Code can't switch for it says why. */
export function AgentSwitchChip({
  skill,
  agent,
  ctx,
  busy,
  onToggle,
}: {
  skill: Skill;
  agent: SkillAgent;
  ctx: SkillsContext;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <AgentChip
      agent={agent}
      agents={ctx.installed}
      on={hasAccess(skill, agent)}
      blocker={switchBlocker(skill, agent)}
      disabled={busy}
      onToggle={onToggle}
    />
  );
}
