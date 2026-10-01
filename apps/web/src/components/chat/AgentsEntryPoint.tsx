import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { isElectron } from "../../env";
import { useInstalledExtensions } from "../../extensions/installedEnvironment";
import {
  AGENTS_PACK_SURFACE_ID,
  findInstalledThreadSurface,
  openInstalledSurface,
} from "../../extensions/installedSurfaceOpen";
import { useRightPanelStore } from "../../rightPanelStore";

export interface AgentsEntryScope {
  readonly threadRef: ScopedThreadRef | null;
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string } | null;
  readonly worktreePath: string | null;
}

/**
 * The one way native Agents entry points (spawn CTA rows, the empty-state
 * card, the header badge) open the roster. With the Agents pack installed it
 * opens the pack's surface, so there is one Agents surface per thread, not two;
 * otherwise it opens the native panel.
 */
export function useOpenAgentsSurface({ threadRef, project, worktreePath }: AgentsEntryScope) {
  const client = isElectron ? "desktop" : "web";
  const { installations } = useInstalledExtensions(threadRef?.environmentId ?? null);
  const packSurface = useMemo(
    () =>
      project
        ? findInstalledThreadSurface(installations, AGENTS_PACK_SURFACE_ID, project.id, client)
        : null,
    [client, installations, project],
  );
  return useCallback(() => {
    if (!threadRef) return;
    if (
      packSurface &&
      project &&
      openInstalledSurface(
        { environmentId: threadRef.environmentId, client },
        threadRef,
        packSurface.installationId,
        packSurface.surface,
        "side-panel",
        { projectId: project.id, workspaceRoot: project.workspaceRoot, worktreePath },
      )
    )
      return;
    useRightPanelStore.getState().open(threadRef, "agents");
  }, [client, packSurface, project, threadRef, worktreePath]);
}

/**
 * Live-agent count pill on the header's right panel toggle. It is its own
 * button: clicking it opens the Agents roster, whereas the toggle underneath
 * reopens whichever panel was last shown.
 */
export function AgentsHeaderBadge({ count, ...scope }: AgentsEntryScope & { count: number }) {
  const openAgents = useOpenAgentsSurface(scope);
  if (count <= 0) return null;
  const label = `Open agents, ${count} ${count === 1 ? "agent" : "agents"} working`;
  return (
    <button
      type="button"
      aria-label={label}
      data-agents-header-badge
      onClick={openAgents}
      className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 cursor-pointer items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white [-webkit-app-region:no-drag]"
    >
      {count}
    </button>
  );
}
