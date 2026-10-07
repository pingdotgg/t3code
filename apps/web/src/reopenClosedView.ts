import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { OpenPreviewMutation } from "./browser/openFileInPreview";
import type { ClosedView, ClosedViewEntry } from "./closedViewStore";
import type { PullRequestListPreferences } from "./components/pullRequest/pullRequestListPreferences";
import { openPreviewSession } from "./components/preview/openPreviewSession";
import {
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

export interface ReopenOwnerState {
  /** False when the entry's environment is not in the catalog. */
  environmentKnown: boolean;
  catalogReady: boolean;
  /** Whether the owning thread or draft still exists locally. */
  ownerExists: boolean;
  /** A live shell that lacks the thread means it was deleted; a cached one may just be stale. */
  shellLive: boolean;
  panel: ThreadRightPanelState;
}

/**
 * Picks the history entry the next reopen press restores, newest first. Entries whose
 * environment is gone or whose tab is already open are dropped. A thread missing from a
 * live shell is skipped but kept; anything not yet knowable stops the scan with no restore.
 */
export function planNextReopen(
  entries: readonly ClosedViewEntry[],
  ownerState: (entry: ClosedViewEntry) => ReopenOwnerState,
): { drop: ClosedViewEntry[]; restore: ClosedViewEntry | null } {
  const drop: ClosedViewEntry[] = [];
  for (const entry of entries) {
    const owner = ownerState(entry);
    if (!owner.environmentKnown) {
      if (!owner.catalogReady) break;
      drop.push(entry);
      continue;
    }
    if (!owner.ownerExists) {
      if (owner.shellLive) continue;
      break;
    }
    const alreadyOpen =
      entry.kind === "panel-tab"
        ? owner.panel.isOpen && owner.panel.surfaces.some((s) => s.id === entry.surface.id)
        : owner.panel.surfaces.some(
            (s) => s.kind === "preview" && s.resourceId === entry.snapshot.tabId,
          );
    if (alreadyOpen) {
      drop.push(entry);
      continue;
    }
    return { drop, restore: entry };
  }
  return { drop, restore: null };
}

type PullRequestsSearchLike = Partial<PullRequestListPreferences> & {
  repository?: string;
  number?: number;
  selectedProjectId?: ProjectId;
  selectedHost?: string;
  selectedEnvironmentId?: EnvironmentId;
};

/** Selects the restored pull request on the Pull Requests page, keeping the list filters. */
export function pullRequestsSearchForRestore<S extends PullRequestsSearchLike>(
  previous: S,
  selected: RightPanelSurface | null,
): S & PullRequestListPreferences {
  const {
    repository: _repository,
    number: _number,
    selectedProjectId: _projectId,
    selectedHost: _host,
    selectedEnvironmentId: _environmentId,
    ...filters
  } = previous;
  return {
    ...filters,
    involvement: previous.involvement ?? "all",
    state: previous.state ?? "open",
    ...(selected?.kind === "pull-request"
      ? {
          repository: selected.repository,
          number: selected.number,
          selectedProjectId: selected.projectId as ProjectId,
          ...(selected.host === undefined ? {} : { selectedHost: selected.host }),
          ...(selected.environmentId === undefined
            ? {}
            : { selectedEnvironmentId: selected.environmentId as EnvironmentId }),
        }
      : {}),
  } as S & PullRequestListPreferences;
}

export async function reopenClosedView(
  view: ClosedView,
  options: {
    openPreview: OpenPreviewMutation;
    workspaceAvailable: boolean;
  },
): Promise<boolean> {
  const panels = useRightPanelStore.getState();
  const ref = view.threadRef;

  if (view.kind === "browser") {
    const url = view.snapshot.navStatus._tag === "Idle" ? undefined : view.snapshot.navStatus.url;
    const result = await openPreviewSession({
      openPreview: options.openPreview,
      threadRef: ref,
      ...(url === undefined ? {} : { url }),
      ...(view.snapshot.viewport === undefined ? {} : { viewport: view.snapshot.viewport }),
      ...(view.snapshot.profileId === undefined ? {} : { profileId: view.snapshot.profileId }),
    });
    if (result._tag === "Failure") return false;
    panels.openBrowser(ref, result.value.tabId);
    return true;
  }
  const surface = view.surface;
  if (
    !options.workspaceAvailable &&
    (surface.kind === "files" || (surface.kind === "file" && !surface.attachment))
  )
    return false;
  switch (surface.kind) {
    case "preview":
      if (surface.resourceId !== null) return false;
      panels.openBrowser(ref, null);
      break;
    case "file":
      if (surface.attachment) panels.openAttachment(ref, surface.attachment);
      else panels.openFile(ref, surface.relativePath, surface.revealLine ?? undefined);
      break;
    case "device":
      if (surface.target) {
        panels.openDevice(ref, surface.target);
        if (surface.title) panels.renameDevice(ref, surface.id, surface.title);
      } else panels.open(ref, "device");
      break;
    case "pull-request":
      panels.openPullRequest(ref, surface);
      break;
    default:
      panels.open(ref, surface.kind);
  }
  return true;
}
