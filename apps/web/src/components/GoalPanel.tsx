import type { OrchestrationThreadGoal } from "@t3tools/contracts";
import { memo } from "react";

import { ScrollArea } from "./ui/scroll-area";
import { ThreadGoalPanel } from "./ThreadGoalPanel";

interface GoalPanelProps {
  activeGoal: OrchestrationThreadGoal | null;
  commandDisabled?: boolean | null;
  onSubmitGoalCommand?: (command: "/goal pause" | "/goal resume" | "/goal clear") => void;
}

export const GoalPanel = memo(function GoalPanel({
  activeGoal,
  commandDisabled = false,
  onSubmitGoalCommand,
}: GoalPanelProps) {
  return (
    <ScrollArea className="min-h-0 flex-1 bg-card/50">
      <div className="p-3">
        {activeGoal ? (
          <ThreadGoalPanel
            goal={activeGoal}
            commandDisabled={commandDisabled}
            {...(onSubmitGoalCommand ? { onSubmitGoalCommand } : {})}
          />
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-[13px] text-muted-foreground/50">No active goal.</p>
            <p className="mt-1 text-[11px] text-muted-foreground/35">
              Start one with the /goal command.
            </p>
          </div>
        )}
      </div>
    </ScrollArea>
  );
});
