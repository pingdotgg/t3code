/**
 * Epic detail panel (§7): the cluster companion — title, rollup stats, frame
 * action, and a story list. Split out of t3work-PlanningSpacePanel.tsx.
 */

import { Crosshair, X } from "lucide-react";

import type { PlanningEpic, PlanningStory } from "./t3work-planningSpaceData";
import { STATE_COLOR, formatHours } from "./t3work-PlanningSpacePanelParts";

export function PlanningSpaceEpicPanel({
  epic,
  stories,
  onClose,
  onFrame,
  onOpenStory,
}: {
  epic: PlanningEpic;
  stories: ReadonlyArray<PlanningStory>;
  onClose: () => void;
  onFrame: () => void;
  onOpenStory: (storyId: string) => void;
}) {
  return (
    <div
      data-ps-chrome="true"
      data-planning-panel="true"
      className="absolute bottom-3 right-3 top-3 z-30 flex w-72 flex-col gap-2.5 overflow-y-auto rounded-lg border border-border bg-background/95 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Epic</span>
        <span className="font-mono text-[10px] text-muted-foreground">{epic.key}</span>
        <button
          type="button"
          aria-label="Close details"
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="text-[13px] leading-snug text-foreground">{epic.title}</div>
      <div className="text-[11px] tabular-nums text-muted-foreground">
        {epic.storyIds.length} items · Σ {formatHours(epic.totalHoursSeconds)} · {epic.readyCount}{" "}
        ready
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1 self-start rounded-md border border-border/70 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
        onClick={onFrame}
      >
        <Crosshair className="size-3" />
        Frame cluster
      </button>
      <div className="text-[10.5px] text-muted-foreground">Stories</div>
      <div className="flex flex-col gap-1">
        {stories.map((story) => (
          <button
            key={story.id}
            type="button"
            className="flex items-center gap-1.5 rounded-md border border-border/60 px-1.5 py-1 text-left hover:border-primary/50"
            onClick={() => onOpenStory(story.id)}
            title={story.title}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: STATE_COLOR[story.planningState] }}
            />
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/85">
              {story.title}
            </span>
            <span className="shrink-0 text-[9.5px] tabular-nums text-primary">
              {story.aggregateHoursSeconds > 0
                ? formatHours(story.aggregateHoursSeconds)
                : formatHours(story.ownHoursSeconds)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
