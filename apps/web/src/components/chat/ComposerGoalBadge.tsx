import type { OrchestrationThreadGoal } from "@t3tools/contracts";
import { memo } from "react";

import { GoalChip, type GoalChipAction } from "./GoalChip";

/**
 * Objective pill perched on the composer's top-left shoulder (mirrors the stash
 * badge on the right). Text click edits the Goal via the composer; the icons
 * pause, resume, or delete it.
 */
export const ComposerGoalBadge = memo(function ComposerGoalBadge(props: {
  readonly goal: OrchestrationThreadGoal | null | undefined;
  readonly isWorking?: boolean;
  readonly onAction?: ((action: GoalChipAction) => void) | undefined;
  readonly onEdit?: ((objective: string) => void) | undefined;
}) {
  if (props.goal == null) {
    return null;
  }

  return (
    // The stash pill owns the right shoulder at the same -top-3 line; reserve
    // it here so a long Objective truncates instead of sliding underneath.
    <div
      className="absolute -top-3 left-4 z-10 max-w-[calc(100%-9rem)]"
      data-composer-goal-badge="true"
    >
      <GoalChip
        goal={props.goal}
        isWorking={props.isWorking === true}
        onAction={props.onAction}
        onEdit={props.onEdit}
      />
    </div>
  );
});
