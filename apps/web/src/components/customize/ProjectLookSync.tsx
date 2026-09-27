import { useLayoutEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { useProjects, useThreadShell } from "../../state/entities";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { deriveLogicalProjectKey } from "../../logicalProject";
import { getActiveLookProjectKey, setActiveLookProjectKey } from "../../hooks/useSettings";
import { useCustomizeInterfaceStore } from "./customizeInterfaceStore";

/** Switch the read-time overlay before paint; navigation never writes settings. */
export function ProjectLookSync() {
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  const thread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft"
      ? store.getDraftSession(target.draftId)
      : target?.kind === "server"
        ? store.getDraftThread(target.threadRef)
        : null,
  );
  const owner = thread ?? draft;
  const projects = useProjects();
  const project = projects.find(
    (entry) => entry.id === owner?.projectId && entry.environmentId === owner?.environmentId,
  );
  // Cold deep links use Default until project entities resolve. Keeping the shell
  // visible is preferable to blocking on a remote environment; this layout effect
  // applies the look before the next paint. Settings hydration also calls syncLookTheme.
  const key = project ? deriveLogicalProjectKey(project) : null;
  useLayoutEffect(() => {
    if (getActiveLookProjectKey() === key) return;
    setActiveLookProjectKey(key);
    // Undo belongs to one editing target, never the project just left.
    const store = useCustomizeInterfaceStore.getState();
    if (store.active) {
      store.close();
      store.open();
    }
  }, [key]);
  return null;
}
