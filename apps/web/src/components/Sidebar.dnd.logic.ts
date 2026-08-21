import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

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

export interface SidebarDndPointerAnchor {
  readonly x: number;
  readonly y: number;
}

export type SidebarThreadDragPhase =
  | "dragging"
  | "awaiting-snooze-choice"
  | "committing"
  | "reconciling";

export interface SidebarThreadDropTarget {
  readonly section: SidebarDndSection;
  readonly threadKey: string | null;
  readonly edge: "before" | "after" | null;
}

export interface SidebarThreadDragTransaction {
  readonly phase: SidebarThreadDragPhase;
  readonly sourceThread: EnvironmentThreadShell;
  readonly sourceThreadKey: string;
  readonly sourceSection: SidebarDndSection;
  readonly sourceIndex: number;
  readonly sourceRect: { readonly width: number; readonly height: number };
  readonly pointerAnchor: SidebarDndPointerAnchor;
  readonly target: SidebarThreadDropTarget | null;
  readonly receiptSequencesByEnvironment: ReadonlyMap<
    EnvironmentThreadShell["environmentId"],
    number
  > | null;
  readonly viewportRailTopBySection: ReadonlyMap<SidebarDndSection, number> | null;
}

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
