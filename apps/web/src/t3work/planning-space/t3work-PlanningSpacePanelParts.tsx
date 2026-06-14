/**
 * Shared building blocks for the planning panel family (§7): hour formatting,
 * planning-state label/colour maps, the panel action contract, and the two
 * reusable controls (HourStepper, OwnerAffordance — the latter carries
 * `data-owner-affordance` so the interaction machine handles it like in-space).
 * Split out of t3work-PlanningSpacePanel.tsx.
 */

import { Minus, Plus } from "lucide-react";

import type { PlanningStory } from "./t3work-planningSpaceData";
import { steppedHours } from "./t3work-planningSpaceScene";

export function formatHours(seconds: number): string {
  if (seconds <= 0) return "–";
  const hours = seconds / 3600;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

export const STATE_LABEL: Record<PlanningStory["planningState"], string> = {
  ready: "Ready",
  "needs-owner": "Needs owner",
  "needs-estimate": "Needs estimate",
  "needs-owner-and-estimate": "Needs owner + estimate",
};

export const STATE_COLOR: Record<PlanningStory["planningState"], string> = {
  ready: "#10b981",
  "needs-owner": "#f59e0b",
  "needs-estimate": "#ec4899",
  "needs-owner-and-estimate": "#ef4444",
};

export interface PlanningSpacePanelActions {
  readonly onClose: () => void;
  readonly onOpenSubtask: (subtaskId: string) => void;
  readonly onOpenStory: () => void;
  readonly onSetSubtaskHours: (subtaskId: string, seconds: number) => void;
  readonly onCreateSubtask: (title: string) => void;
  readonly onSetSprintMembership: (inSprint: boolean) => void;
  readonly onFrameEpic: () => void;
  readonly onRevealInSpace: () => void;
}

export function HourStepper({
  seconds,
  onChange,
  compact,
}: {
  seconds: number;
  onChange: (next: number) => void;
  compact?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Decrease estimate"
        className="flex size-5 items-center justify-center rounded border border-border/70 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => onChange(steppedHours(seconds, -1))}
      >
        <Minus className="size-3" />
      </button>
      <span
        className={`min-w-7 text-center tabular-nums text-primary ${
          compact ? "text-[10px]" : "text-[12px]"
        }`}
      >
        {formatHours(seconds)}
      </span>
      <button
        type="button"
        aria-label="Increase estimate"
        className="flex size-5 items-center justify-center rounded border border-border/70 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => onChange(steppedHours(seconds, 1))}
      >
        <Plus className="size-3" />
      </button>
    </span>
  );
}

export function OwnerAffordance({
  storyId,
  subtaskId,
  ownerName,
  active,
}: {
  storyId: string;
  subtaskId?: string;
  ownerName: string | null;
  active: boolean;
}) {
  return (
    <button
      type="button"
      data-owner-affordance="true"
      data-story-id={storyId}
      {...(subtaskId !== undefined ? { "data-subtask-id": subtaskId } : {})}
      className={`inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-0.5 text-[11px] hover:border-primary/60 ${
        active ? "ring-2 ring-primary" : ""
      }`}
      title={
        ownerName
          ? `${ownerName} — click, then pick a person below`
          : "Unassigned — click, then pick a person below"
      }
    >
      <span
        className="size-2 rounded-full"
        style={{
          background: ownerName ? "#10b981" : "transparent",
          border: ownerName ? "none" : "1px dashed #8a8a93",
        }}
      />
      {ownerName ?? "Unassigned"}
    </button>
  );
}
