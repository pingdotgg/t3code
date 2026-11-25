import type {
  EnvironmentId,
  PullRequestLinkedThreadsResult,
  ScopedThreadRef,
} from "@lathe/contracts";

import type { DraftId } from "./composerDraftStore";
import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteOpenDetail {
  // Fork: roadmap. "roadmap-attach" opens the work item picker for `roadmapThreadRef`.
  readonly open?: "add-project" | "new-thread-in" | "depends-on" | "roadmap-attach";
  /** With add-project: the draft the new project is picked for. */
  readonly draftId?: DraftId | null;
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /** The waiting thread the "Depends on" picker parks. Required for that mode. */
  readonly blockedThreadRef?: ScopedThreadRef;
  /** Fork: roadmap. The thread the work item picker attaches. Required for that mode. */
  readonly roadmapThreadRef?: ScopedThreadRef;
  /** Fork: roadmap. With "new-thread-in", told the thread the chosen project starts. */
  readonly onThreadCreated?: (thread: ScopedThreadRef) => void;
}

/** Open the palette on the "Depends on" picker for a thread that should wait. */
export function openThreadDependencyPicker(blockedThreadRef: ScopedThreadRef): void {
  openCommandPalette({ open: "depends-on", blockedThreadRef });
}

/** Fork: roadmap. Open the palette on the work item picker for a thread. */
export function openRoadmapAttachPicker(roadmapThreadRef: ScopedThreadRef): void {
  openCommandPalette({ open: "roadmap-attach", roadmapThreadRef });
}

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({
      _tag: "OpenNewThreadIn",
      ...(detail.onThreadCreated ? { onThreadCreated: detail.onThreadCreated } : {}),
    });
  } else if (detail.open === "depends-on" && detail.blockedThreadRef) {
    dispatchCommandPalette({ _tag: "OpenDependsOn", blockedThreadRef: detail.blockedThreadRef });
  } else if (detail.open === "roadmap-attach" && detail.roadmapThreadRef) {
    dispatchCommandPalette({ _tag: "OpenRoadmapAttach", threadRef: detail.roadmapThreadRef });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({
      _tag: "OpenAddProject",
      ...(detail.draftId ? { draftId: detail.draftId } : {}),
    });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
