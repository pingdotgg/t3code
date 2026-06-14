/**
 * Subtask detail panel (§7): the subtask branch of the story companion — key +
 * parent crumb, estimate stepper, owner affordance, description. Split out of
 * t3work-PlanningSpacePanel.tsx.
 */

import { ArrowUp, X } from "lucide-react";

import type { PlanningStory, PlanningSubtask } from "./t3work-planningSpaceData";
import {
  HourStepper,
  OwnerAffordance,
  type PlanningSpacePanelActions,
} from "./t3work-PlanningSpacePanelParts";

export function PlanningSpaceSubtaskPanel({
  story,
  subtask,
  assignActiveFor,
  actions,
}: {
  story: PlanningStory;
  subtask: PlanningSubtask;
  assignActiveFor: string | null;
  actions: PlanningSpacePanelActions;
}) {
  return (
    <div
      data-ps-chrome="true"
      data-planning-panel="true"
      className="absolute bottom-3 right-3 top-3 z-30 flex w-72 flex-col gap-2.5 overflow-y-auto rounded-lg border border-border bg-background/95 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{subtask.key}</span>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 truncate text-[10px] text-primary hover:underline"
          onClick={actions.onOpenStory}
          title={`Back to ${story.key}`}
        >
          <ArrowUp className="size-3 shrink-0" />
          {story.key}
        </button>
        <button
          type="button"
          aria-label="Close details"
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={actions.onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="text-[13px] leading-snug text-foreground">{subtask.title}</div>
      <div className="flex items-center gap-2">
        <span className="w-14 text-[10.5px] text-muted-foreground">Estimate</span>
        <HourStepper
          seconds={subtask.hoursSeconds}
          onChange={(next) => actions.onSetSubtaskHours(subtask.id, next)}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 text-[10.5px] text-muted-foreground">Owner</span>
        <OwnerAffordance
          storyId={story.id}
          subtaskId={subtask.id}
          ownerName={subtask.ownerName}
          active={assignActiveFor === subtask.id}
        />
      </div>
      <div className="text-[10.5px] text-muted-foreground">Description</div>
      <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
        {subtask.description ?? "No description yet."}
      </div>
    </div>
  );
}
