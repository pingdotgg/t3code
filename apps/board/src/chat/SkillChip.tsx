import type { ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Sparkles } from "lucide-react";

import { Tooltip } from "../ui/Tooltip";

/** One `$skill` a message names, drawn as a chip that says what the skill does. */
export function SkillChip({ skill }: { skill: ServerProviderSkill }) {
  const label = formatProviderSkillDisplayName(skill);
  const description = skill.description?.trim() || skill.shortDescription?.trim();
  return (
    <Tooltip text={description || `Skill ${label}`}>
      <span
        data-testid="skill-chip"
        aria-label={`Skill ${label}`}
        className="mx-px inline-flex items-center gap-1 rounded-md bg-hover px-1.5 align-baseline text-[12px] text-fg"
      >
        <Sparkles className="size-3 text-focus" aria-hidden />
        {label}
      </span>
    </Tooltip>
  );
}
