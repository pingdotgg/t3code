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
 * One agent and its own switch for a skill. An agent T3 Code can't switch has the switch disabled,
 * and says why when pointed at.
 */
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
  const on = hasAccess(skill, agent);
  const blocker = switchBlocker(skill, agent);
  const chip = (
    <>
      <SkillAgentIcon agent={agent} agents={ctx.installed} active={on} />
      {agent.displayName}
      <Switch
        size="sm"
        aria-label={agent.displayName}
        checked={on}
        disabled={busy || blocker !== null}
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
