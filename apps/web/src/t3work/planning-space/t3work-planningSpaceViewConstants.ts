/**
 * Planning space view constants and small pure helpers (palettes, formatting,
 * gauge anchors). Extracted verbatim from t3work-PlanningSpaceView.tsx.
 */

import { NO_EPIC_ID, type PlanningStory } from "./t3work-planningSpaceData";
import type { PlanningItemRef } from "./t3work-planningSpaceInteractions";

/** Per-person sprint capacity until the Tempo integration lands (§10.2). */
export const DEFAULT_CAPACITY_SECONDS = 40 * 3600;

export type PlanningSpaceGrouping = "epic" | "sprint" | "owner";

export interface PlanningSpaceMutations {
  readonly onAssign?: ((item: PlanningItemRef, ownerId: string | null) => void) | undefined;
  readonly onSetSprintMembership?: ((storyId: string, inSprint: boolean) => void) | undefined;
  readonly onReparent?: ((storyId: string, epicId: string) => void) | undefined;
  readonly onSetSubtaskHours?: ((subtaskId: string, seconds: number) => void) | undefined;
  readonly onCreateSubtask?: ((storyId: string, title: string) => void) | undefined;
}

export const GROUPINGS: ReadonlyArray<{ value: PlanningSpaceGrouping; label: string }> = [
  { value: "epic", label: "By epic" },
  { value: "sprint", label: "By sprint" },
  { value: "owner", label: "By owner" },
];

/**
 * Gauge anchors live in story-plane SCALE space so labels land exactly in
 * their band (mid-band representative scales for the §3.2 thresholds
 * 0.3 / 0.62 / 0.92 / 1.3 / 1.8). The "All" anchor is the dynamic fit scale.
 */
export const GAUGE_LABELS = ["All", "Epics", "Stories", "Cards", "Tasks", "Full"] as const;
export const GAUGE_ANCHOR_SCALES = [0.22, 0.76, 1.1, 1.5, 2.0] as const;

const EPIC_PALETTE = [
  "#8d85e8",
  "#54c8a2",
  "#f0997b",
  "#ed93b1",
  "#85b7eb",
  "#ef9f27",
  "#d4537e",
  "#49b9a0",
  "#97c459",
  "#aab3ff",
  "#e8a87c",
  "#c9a0f0",
] as const;

export function epicColor(epicId: string, epicOrder: ReadonlyArray<string>): string {
  if (epicId === NO_EPIC_ID) return "#8a8a93";
  const index = Math.max(0, epicOrder.indexOf(epicId));
  return EPIC_PALETTE[index % EPIC_PALETTE.length] ?? "#8a8a93";
}

export const PLANNING_STATE_COLOR: Record<PlanningStory["planningState"], string> = {
  ready: "#10b981",
  "needs-owner": "#f59e0b",
  "needs-estimate": "#ec4899",
  "needs-owner-and-estimate": "#ef4444",
};

export function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const OWNER_PALETTE = [
  "#7c89ff",
  "#ed93b1",
  "#49b9a0",
  "#ef9f27",
  "#8d85e8",
  "#54c8a2",
  "#f0997b",
  "#d4537e",
  "#85b7eb",
  "#97c459",
] as const;

export function ownerColor(ownerId: string): string {
  const hash = Math.abs([...ownerId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0));
  return OWNER_PALETTE[hash % OWNER_PALETTE.length] ?? "#7c89ff";
}

export function formatHours(seconds: number): string {
  if (seconds <= 0) return "–";
  const hours = seconds / 3600;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)}h`;
}
