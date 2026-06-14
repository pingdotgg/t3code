/**
 * The story "frame" node rendered into the planning space stage — the §3.3 card
 * that band-CSS reveals progressively (dot → card → subtask grid). Memoized on
 * the story identity plus whether the assign affordance touches it. Extracted
 * from t3work-PlanningSpaceView.tsx.
 */

import { Minus, Plus } from "lucide-react";
import { memo } from "react";

import { JiraIssueTypeIcon } from "~/t3work/components/ticket/t3work-JiraIssueType";

import { steppedHours } from "./t3work-planningSpaceScene";
import {
  type PlanningStoryFrameProps,
  arePlanningStoryFramePropsEqual,
} from "./t3work-planningSpaceStoryFrameEqual";
import {
  PLANNING_STATE_COLOR,
  formatHours,
  initialsOf,
  ownerColor,
} from "./t3work-planningSpaceViewConstants";

export const PlanningStoryFrame = memo(function PlanningStoryFrame({
  story,
  color,
  frameRef,
  assignTarget,
  onSetSubtaskHours,
  onContextMenu,
}: PlanningStoryFrameProps) {
  const stateColor = PLANNING_STATE_COLOR[story.planningState];
  const storyAffordanceActive = assignTarget?.kind === "story" && assignTarget.storyId === story.id;
  return (
    <div
      ref={frameRef}
      className="t3ps-node"
      data-node-id={story.id}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, story.id) : undefined}
    >
      <div className="t3ps-inner">
        <span className="t3ps-dot" style={{ background: stateColor }} title={story.title} />
        <div
          className={`t3ps-card rounded-[10px] border bg-background/95 ${
            story.isContextParent || story.isPlaceholder ? "border-dashed opacity-90" : ""
          } ${story.resolved ? "opacity-60" : ""}`}
          style={{ borderColor: `${color}55` }}
          title={story.title}
        >
          <div className="t3ps-header flex min-w-0 cursor-pointer items-center gap-1.5">
            <JiraIssueTypeIcon
              issueType={story.issueType}
              issueTypeIconUrl={story.issueTypeIconUrl ?? undefined}
            />
            <span className="t3ps-key truncate font-mono text-[10px] text-muted-foreground">
              {story.key}
            </span>
            {story.isContextParent ? (
              <span className="rounded border border-dashed border-muted-foreground/50 px-1 text-[8px] text-muted-foreground">
                context
              </span>
            ) : null}
            <span className="t3ps-sum ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] tabular-nums text-primary">
              {story.aggregateHoursSeconds > 0
                ? `Σ ${formatHours(story.aggregateHoursSeconds)}`
                : formatHours(story.ownHoursSeconds)}
            </span>
            <button
              type="button"
              data-owner-affordance="true"
              data-story-id={story.id}
              className={`t3ps-avatar flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-medium text-background ${
                storyAffordanceActive ? "ring-2 ring-primary" : ""
              }`}
              style={{
                background: story.ownerName ? stateColor : "transparent",
                border: story.ownerName ? "none" : "1px dashed currentColor",
                color: story.ownerName ? undefined : "inherit",
              }}
              title={
                story.ownerName
                  ? `${story.ownerName} — click to reassign`
                  : "Unassigned — click to assign"
              }
            >
              {story.ownerName ? initialsOf(story.ownerName) : "+"}
            </button>
          </div>
          <div className="t3ps-title mt-1 line-clamp-2 text-[11.5px] leading-snug text-foreground">
            {story.title}
          </div>
          <div className="t3ps-subdots mt-1.5 flex flex-wrap gap-[3px]">
            {story.subtasks.map((subtask) => (
              <span
                key={subtask.id}
                className="size-1.5 rounded-full"
                style={{
                  background: subtask.ownerName ? ownerColor(subtask.ownerId ?? "") : "#8a8a93",
                  opacity: subtask.resolved ? 0.3 : 1,
                }}
                title={`${subtask.title} — ${
                  subtask.ownerName ?? "unassigned"
                } · ${formatHours(subtask.hoursSeconds)}`}
              />
            ))}
          </div>
          <div className="t3ps-subgrid mt-1.5 grid grid-cols-2 gap-1.5">
            {story.subtasks.map((subtask) => {
              const subAffordanceActive =
                assignTarget?.kind === "subtask" && assignTarget.subtaskId === subtask.id;
              return (
                <div
                  key={subtask.id}
                  data-subtask-id={subtask.id}
                  className={`cursor-pointer rounded-md border border-border/70 bg-muted/30 px-1.5 py-1 hover:border-primary/50 ${
                    subtask.resolved ? "opacity-50" : ""
                  }`}
                  title={subtask.title}
                >
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-ps-chrome="true"
                      aria-label="Decrease estimate"
                      className="t3ps-substep hidden size-3.5 items-center justify-center rounded border border-border/60 text-[9px] text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        onSetSubtaskHours(subtask.id, steppedHours(subtask.hoursSeconds, -1))
                      }
                    >
                      <Minus className="size-2.5" />
                    </button>
                    <span className="rounded bg-primary/10 px-1 text-[8.5px] tabular-nums text-primary">
                      {formatHours(subtask.hoursSeconds)}
                    </span>
                    <button
                      type="button"
                      data-ps-chrome="true"
                      aria-label="Increase estimate"
                      className="t3ps-substep hidden size-3.5 items-center justify-center rounded border border-border/60 text-[9px] text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        onSetSubtaskHours(subtask.id, steppedHours(subtask.hoursSeconds, 1))
                      }
                    >
                      <Plus className="size-2.5" />
                    </button>
                    <button
                      type="button"
                      data-owner-affordance="true"
                      data-story-id={story.id}
                      data-subtask-id={subtask.id}
                      className={`ml-auto size-2.5 shrink-0 rounded-full ${
                        subAffordanceActive ? "ring-2 ring-primary" : ""
                      }`}
                      style={{
                        background: subtask.ownerName
                          ? ownerColor(subtask.ownerId ?? "")
                          : "transparent",
                        border: subtask.ownerName ? "none" : "1px dashed #8a8a93",
                      }}
                      title={
                        subtask.ownerName
                          ? `${subtask.ownerName} — click to reassign`
                          : "Unassigned — click to assign"
                      }
                    />
                  </div>
                  <div className="t3ps-subtitle mt-0.5 truncate text-[9px] leading-tight text-foreground/80">
                    {subtask.title}
                  </div>
                </div>
              );
            })}
            {story.subtasks.length === 0 ? (
              <div className="col-span-2 px-1 py-0.5 text-[9px] text-muted-foreground">
                No subtasks yet — planning starts here.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}, arePlanningStoryFramePropsEqual);
