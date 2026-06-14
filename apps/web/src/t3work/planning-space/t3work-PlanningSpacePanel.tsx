/**
 * Story detail panel (spec §7): the quick-edit + navigation companion for bands
 * 0–4 (per-item singleton; camera never moves). Subtask/epic panels and shared
 * parts live in the sibling t3work-PlanningSpace*Panel* modules.
 */

import { ArrowUp, Crosshair, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PlanningEpic, PlanningStory, PlanningSubtask } from "./t3work-planningSpaceData";
import {
  HourStepper,
  OwnerAffordance,
  type PlanningSpacePanelActions,
  STATE_COLOR,
  STATE_LABEL,
  formatHours,
} from "./t3work-PlanningSpacePanelParts";
import { PlanningSpaceSubtaskPanel } from "./t3work-PlanningSpaceSubtaskPanel";

export { PlanningSpaceEpicPanel } from "./t3work-PlanningSpaceEpicPanel";
export type { PlanningSpacePanelActions } from "./t3work-PlanningSpacePanelParts";

export function PlanningSpacePanel({
  story,
  subtask,
  epic,
  assignActiveFor,
  actions,
}: {
  story: PlanningStory;
  subtask: PlanningSubtask | null;
  epic: PlanningEpic | null;
  assignActiveFor: string | null;
  actions: PlanningSpacePanelActions;
}) {
  const [draftTitle, setDraftTitle] = useState("");
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const previousSubtaskCount = useRef(story.subtasks.length);

  // Add-subtask micro-flow (§6.5): keep the input focused after a create lands.
  useEffect(() => {
    if (story.subtasks.length > previousSubtaskCount.current) {
      addInputRef.current?.focus();
    }
    previousSubtaskCount.current = story.subtasks.length;
  }, [story.subtasks.length]);

  const submitSubtask = () => {
    const title = draftTitle.trim();
    if (!title) return;
    actions.onCreateSubtask(title);
    setDraftTitle("");
  };

  if (subtask) {
    return (
      <PlanningSpaceSubtaskPanel
        story={story}
        subtask={subtask}
        assignActiveFor={assignActiveFor}
        actions={actions}
      />
    );
  }

  return (
    <div
      data-ps-chrome="true"
      data-planning-panel="true"
      className="absolute bottom-3 right-3 top-3 z-30 flex w-72 flex-col gap-2.5 overflow-y-auto rounded-lg border border-border bg-background/95 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{story.key}</span>
        <span className="truncate text-[10px]" style={{ color: STATE_COLOR[story.planningState] }}>
          {STATE_LABEL[story.planningState]}
        </span>
        <button
          type="button"
          aria-label="Close details"
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={actions.onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="text-[13px] leading-snug text-foreground">{story.title}</div>
      <div className="flex items-center gap-2">
        <span className="w-14 text-[10.5px] text-muted-foreground">Effort</span>
        <span className="text-[12px] tabular-nums text-primary">
          {story.aggregateHoursSeconds > 0
            ? `Σ ${formatHours(story.aggregateHoursSeconds)}`
            : formatHours(story.ownHoursSeconds)}
        </span>
        <span className="text-[9.5px] text-muted-foreground">aggregate — edit on subtasks</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 text-[10.5px] text-muted-foreground">Owner</span>
        <OwnerAffordance
          storyId={story.id}
          ownerName={story.ownerName}
          active={assignActiveFor === story.id}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 text-[10.5px] text-muted-foreground">Sprint</span>
        <button
          type="button"
          className={`rounded-md border px-2 py-0.5 text-[11px] ${
            story.inSprint
              ? "border-primary/70 text-primary"
              : "border-border/70 text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => actions.onSetSprintMembership(true)}
        >
          In sprint
        </button>
        <button
          type="button"
          className={`rounded-md border px-2 py-0.5 text-[11px] ${
            !story.inSprint
              ? "border-primary/70 text-primary"
              : "border-border/70 text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => actions.onSetSprintMembership(false)}
        >
          Outside
        </button>
      </div>
      <div className="text-[10.5px] text-muted-foreground">Navigate</div>
      <div className="flex flex-wrap gap-1.5">
        {epic ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-0.5 text-[10.5px] text-primary hover:border-primary/60"
            onClick={actions.onFrameEpic}
            title={epic.title}
          >
            <ArrowUp className="size-3 shrink-0" />
            {epic.title.length > 24 ? `${epic.title.slice(0, 24)}…` : epic.title}
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
          onClick={actions.onRevealInSpace}
        >
          <Crosshair className="size-3" />
          Reveal in space
        </button>
      </div>
      <div className="text-[10.5px] text-muted-foreground">Description</div>
      <div className="line-clamp-4 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
        {story.description ?? "No description yet."}
      </div>
      <div className="text-[10.5px] text-muted-foreground">
        Subtasks · {story.subtasks.length} · Σ {formatHours(story.aggregateHoursSeconds)}
      </div>
      <div className="flex flex-col gap-1">
        {story.subtasks.map((item) => (
          <div
            key={item.id}
            className={`flex items-center gap-1.5 rounded-md border border-border/60 px-1.5 py-1 ${
              item.resolved ? "opacity-50" : ""
            }`}
          >
            <HourStepper
              seconds={item.hoursSeconds}
              onChange={(next) => actions.onSetSubtaskHours(item.id, next)}
              compact
            />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-[10.5px] text-foreground/85 hover:text-foreground"
              onClick={() => actions.onOpenSubtask(item.id)}
              title={item.title}
            >
              {item.title}
            </button>
            <button
              type="button"
              data-owner-affordance="true"
              data-story-id={story.id}
              data-subtask-id={item.id}
              aria-label={item.ownerName ?? "Assign subtask"}
              className={`size-3 shrink-0 rounded-full ${
                assignActiveFor === item.id ? "ring-2 ring-primary" : ""
              }`}
              style={{
                background: item.ownerName ? "#10b981" : "transparent",
                border: item.ownerName ? "none" : "1px dashed #8a8a93",
              }}
              title={item.ownerName ?? "Unassigned — click to assign"}
            />
          </div>
        ))}
      </div>
      <input
        ref={addInputRef}
        value={draftTitle}
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submitSubtask()}
        placeholder="Add subtask… (Enter creates)"
        className="h-7 rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
    </div>
  );
}
