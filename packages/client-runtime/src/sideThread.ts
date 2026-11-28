import type { OrchestrationV2AppThread, SideThreadOpenTarget } from "@t3tools/contracts";

/**
 * A thread that opens beside the one you are in. `linked` lives on a linked environment this client
 * has no connection to; the others are threads of a connected environment.
 */
export type SideThreadKind = "side-chat" | "subagent" | "provider-subagent" | "linked";

/**
 * Which side thread `thread` is, or null for a thread that opens like any other. A row that does
 * not carry how the thread was created cannot tell a provider's own subagent from the app's.
 */
export function sideThreadKindOf(
  thread:
    | (Pick<OrchestrationV2AppThread, "lineage"> &
        Partial<Pick<OrchestrationV2AppThread, "creationSource">>)
    | null
    | undefined,
): Exclude<SideThreadKind, "linked"> | null {
  if (!thread) return null;
  if (thread.lineage.sideChat === true && thread.lineage.parentThreadId !== null) {
    return "side-chat";
  }
  if (thread.lineage.relationshipToParent !== "subagent") return null;
  return thread.creationSource === "provider" ? "provider-subagent" : "subagent";
}

export type SideThreadComposer =
  /** The normal composer. */
  | "composer"
  /** A bar that says the thread takes no messages. */
  | "read-only"
  /** The same bar, offering to connect to the environment the thread is on. */
  | "read-only-connect";

/** What stands at the bottom of a side thread, in the panel and on the main screen alike. */
export function sideThreadComposer(kind: SideThreadKind): SideThreadComposer {
  switch (kind) {
    case "linked":
      return "read-only-connect";
    case "provider-subagent":
      return "read-only";
    case "side-chat":
    case "subagent":
      return "composer";
  }
}

/**
 * How the user asked to open a side thread: a plain click or Enter, the same with the modifier
 * (or a middle click), or one of the two places named outright, as a context menu does.
 */
export type SideThreadOpenIntent = "primary" | "alternate" | SideThreadOpenTarget;

/**
 * Where a side thread opens. The preference names the plain click's place and the modifier takes
 * the other; without a panel to open in, everything goes to the main view.
 */
export function resolveSideThreadOpenTarget(input: {
  readonly preference: SideThreadOpenTarget;
  readonly intent: SideThreadOpenIntent;
  readonly panelAvailable: boolean;
}): SideThreadOpenTarget {
  if (!input.panelAvailable) return "main";
  switch (input.intent) {
    case "primary":
      return input.preference;
    case "alternate":
      return input.preference === "panel" ? "main" : "panel";
    default:
      return input.intent;
  }
}

/** The intent of a click, an auxiliary click or a key press on a side thread's row. */
export function sideThreadOpenIntentOf(
  event: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    /** Absent on key events. */
    readonly button?: number;
  },
  mac: boolean,
): Extract<SideThreadOpenIntent, "primary" | "alternate"> {
  if (event.button === 1) return "alternate";
  return (mac ? event.metaKey : event.ctrlKey) ? "alternate" : "primary";
}

/** Where a side thread opens on mobile: the inspector pane where the layout has one. */
export function resolveMobileSideThreadPresentation(input: {
  readonly inspectorAvailable: boolean;
}): "inspector" | "full-screen" {
  return input.inspectorAvailable ? "inspector" : "full-screen";
}
