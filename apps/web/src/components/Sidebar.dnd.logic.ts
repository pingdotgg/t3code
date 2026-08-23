import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { SidebarDndBoardEntry } from "./Sidebar.dnd.board";

export type SidebarDndSection = "pinned" | "regular" | "snoozed" | "settled";

export const SIDEBAR_DND_SECTIONS = [
  "pinned",
  "regular",
  "snoozed",
  "settled",
] satisfies ReadonlyArray<SidebarDndSection>;

export type SidebarDndAction =
  | "pin"
  | "unpin"
  | "unsettle"
  | "unsnooze"
  | "settle"
  | "snooze"
  | "reorder-pinned"
  | "noop";

export type SidebarDndPreviewVariant = "card" | "slim";

interface SidebarDndPointerAnchor {
  readonly x: number;
  readonly y: number;
}

export interface SidebarThreadDropTarget {
  readonly section: SidebarDndSection;
  readonly threadKey: string | null;
  readonly edge: "before" | "after" | null;
}

interface SidebarThreadDragTransactionBase {
  readonly sourceThread: EnvironmentThreadShell;
  readonly sourceThreadKey: string;
  readonly sourceSection: SidebarDndSection;
  readonly scopeKey: string | null;
  readonly sourceRect: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pointerAnchor: SidebarDndPointerAnchor;
  readonly initialEntries: readonly SidebarDndBoardEntry[];
  readonly entries: readonly SidebarDndBoardEntry[];
  readonly sectionCounts: Readonly<Record<SidebarDndSection, number>>;
  readonly emptySections: ReadonlySet<SidebarDndSection>;
}

interface SidebarThreadTargetedTransaction extends SidebarThreadDragTransactionBase {
  readonly target: SidebarThreadDropTarget;
}

export interface SidebarThreadDraggingTransaction extends SidebarThreadDragTransactionBase {
  readonly phase: "dragging";
  readonly target: SidebarThreadDropTarget | null;
}

interface SidebarThreadSnoozeChoiceTransaction extends SidebarThreadTargetedTransaction {
  readonly phase: "awaiting-snooze-choice";
  readonly snoozePreset: SnoozePreset | null;
}

type SidebarThreadDropAction = Exclude<SidebarDndAction, "noop">;
type SidebarThreadCommitAction = Exclude<SidebarThreadDropAction, "reorder-pinned">;

export type SidebarThreadDroppingTransaction =
  | (SidebarThreadTargetedTransaction & {
      readonly phase: "dropping";
      readonly action: Exclude<SidebarThreadDropAction, "snooze">;
    })
  | (SidebarThreadTargetedTransaction & {
      readonly phase: "dropping";
      readonly action: "snooze";
      readonly snoozePreset: SnoozePreset;
    });

export interface SidebarThreadCommittingTransaction extends SidebarThreadTargetedTransaction {
  readonly phase: "committing";
  readonly action: SidebarThreadCommitAction;
}

interface SidebarThreadReconcilingTransaction extends SidebarThreadTargetedTransaction {
  readonly phase: "reconciling";
  readonly action: SidebarThreadCommitAction;
  readonly receiptSequencesByEnvironment: ReadonlyMap<
    EnvironmentThreadShell["environmentId"],
    number
  >;
}

export type SidebarThreadDragTransaction =
  | SidebarThreadDraggingTransaction
  | SidebarThreadSnoozeChoiceTransaction
  | SidebarThreadDroppingTransaction
  | SidebarThreadCommittingTransaction
  | SidebarThreadReconcilingTransaction;

const DND_SECTION_ID_PREFIX = "sidebar-thread-section:";

export function sidebarThreadKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function createSidebarDndSectionId(input: { section: SidebarDndSection }): string {
  return `${DND_SECTION_ID_PREFIX}${input.section}`;
}

export function parseSidebarDndSectionId(value: unknown): SidebarDndSection | null {
  if (typeof value !== "string" || !value.startsWith(DND_SECTION_ID_PREFIX)) return null;
  const section = value.slice(DND_SECTION_ID_PREFIX.length);
  switch (section) {
    case "pinned":
    case "regular":
    case "snoozed":
    case "settled":
      return section;
    default:
      return null;
  }
}

/** The lifecycle command that realizes a drop between two sidebar sections. */
export function resolveSidebarDndAction(input: {
  source: SidebarDndSection;
  destination: SidebarDndSection;
}): SidebarDndAction {
  const { destination, source } = input;
  if (source === destination) {
    return source === "pinned" ? "reorder-pinned" : "noop";
  }

  switch (destination) {
    case "pinned":
      return "pin";
    case "snoozed":
      return "snooze";
    case "settled":
      return "settle";
    case "regular":
      return source === "pinned" ? "unpin" : source === "snoozed" ? "unsnooze" : "unsettle";
    default: {
      const _exhaustive: never = destination;
      return _exhaustive;
    }
  }
}

/** Cards remain full-height in pinned and regular sections; parked work is slim. */
export function resolveSidebarDndPreviewVariant(input: {
  source: SidebarDndSection;
  destination: SidebarDndSection | null;
}): SidebarDndPreviewVariant {
  const section = input.destination ?? input.source;
  return section === "snoozed" || section === "settled" ? "slim" : "card";
}
