export type SidebarDndSection = "pinned" | "regular" | "snoozed" | "settled";

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

export interface SidebarDndPoint {
  readonly x: number;
  readonly y: number;
}

export interface SidebarDndRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SidebarDndPointerAnchor {
  readonly x: number;
  readonly y: number;
}

export interface SidebarDndDraggableId {
  readonly kind: "draggable";
  readonly section: SidebarDndSection;
  readonly threadKey: string;
}

export interface SidebarDndRowId {
  readonly kind: "row";
  readonly section: SidebarDndSection;
  readonly threadKey: string;
}

export interface SidebarDndSectionId {
  readonly kind: "section";
  readonly section: SidebarDndSection;
}

export type SidebarDndId = SidebarDndDraggableId | SidebarDndRowId | SidebarDndSectionId;

const DND_ID_PREFIX = "sidebar-thread-dnd";

export function createSidebarDndDraggableId(input: {
  section: SidebarDndSection;
  threadKey: string;
}): string {
  return `${DND_ID_PREFIX}:draggable:${input.section}:${encodeURIComponent(input.threadKey)}`;
}

export function createSidebarDndRowId(input: {
  section: SidebarDndSection;
  threadKey: string;
}): string {
  return `${DND_ID_PREFIX}:row:${input.section}:${encodeURIComponent(input.threadKey)}`;
}

export function createSidebarDndSectionId(input: { section: SidebarDndSection }): string {
  return `${DND_ID_PREFIX}:section:${input.section}`;
}

function parseSection(value: string): SidebarDndSection | null {
  switch (value) {
    case "pinned":
    case "regular":
    case "snoozed":
    case "settled":
      return value;
    default:
      return null;
  }
}

function parseThreadKey(value: string): string | null {
  if (value.length === 0) return null;
  try {
    const threadKey = decodeURIComponent(value);
    return threadKey.length === 0 || encodeURIComponent(threadKey) !== value ? null : threadKey;
  } catch {
    return null;
  }
}

/** Safely parses only IDs produced by the sidebar DnD helpers. */
export function parseSidebarDndId(value: unknown): SidebarDndId | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts[0] !== DND_ID_PREFIX) return null;

  switch (parts[1]) {
    case "draggable":
    case "row": {
      if (parts.length !== 4) return null;
      const section = parseSection(parts[2] ?? "");
      const threadKey = parseThreadKey(parts[3] ?? "");
      if (section === null || threadKey === null) return null;
      return parts[1] === "draggable"
        ? { kind: "draggable", section, threadKey }
        : { kind: "row", section, threadKey };
    }
    case "section": {
      if (parts.length !== 3) return null;
      const section = parseSection(parts[2] ?? "");
      return section === null ? null : { kind: "section", section };
    }
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
    switch (source) {
      case "pinned":
        return "reorder-pinned";
      case "snoozed":
      case "regular":
      case "settled":
        return "noop";
      default: {
        const _exhaustive: never = source;
        return _exhaustive;
      }
    }
  }

  switch (destination) {
    case "pinned":
      return "pin";
    case "snoozed":
      return "snooze";
    case "settled":
      return "settle";
    case "regular":
      switch (source) {
        case "pinned":
          return "unpin";
        case "snoozed":
          return "unsnooze";
        case "settled":
          return "unsettle";
        case "regular":
          return "noop";
        default: {
          const _exhaustive: never = source;
          return _exhaustive;
        }
      }
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
  switch (section) {
    case "pinned":
    case "regular":
      return "card";
    case "snoozed":
    case "settled":
      return "slim";
    default: {
      const _exhaustive: never = section;
      return _exhaustive;
    }
  }
}

/**
 * The cursor's normalized position in the source row. A zero-sized source
 * falls back to its center, so a stale measurement cannot jump the overlay.
 */
export function captureSidebarDndPointerAnchor(input: {
  pointer: SidebarDndPoint;
  sourceRect: SidebarDndRect;
}): SidebarDndPointerAnchor {
  return {
    x: normalizePointerAxis(input.pointer.x, input.sourceRect.left, input.sourceRect.width),
    y: normalizePointerAxis(input.pointer.y, input.sourceRect.top, input.sourceRect.height),
  };
}

function normalizePointerAxis(pointer: number, start: number, length: number): number {
  if (
    !Number.isFinite(pointer) ||
    !Number.isFinite(start) ||
    !Number.isFinite(length) ||
    length <= 0
  ) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, (pointer - start) / length));
}
