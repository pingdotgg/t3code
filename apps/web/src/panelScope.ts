import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { ThreadId, type ProjectId, type ScopedThreadRef } from "@t3tools/contracts";

type SharedPanelResolver = (ref: ScopedThreadRef) => ScopedThreadRef | null;

// Injected at app start: the panel stores cannot import thread state without an import cycle.
let resolveSharedPanel: SharedPanelResolver = () => null;

export function setSharedPanelResolver(resolver: SharedPanelResolver): void {
  resolveSharedPanel = resolver;
}

// One object per project, so hooks that depend on the ref do not re-run every render.
const projectPanelRefs = new Map<string, ScopedThreadRef>();

/** The sentinel ref that owns the panel, drawer and terminals shared by a project's threads. */
export function projectPanelRef(
  environmentId: ScopedThreadRef["environmentId"],
  projectId: ProjectId,
): ScopedThreadRef {
  const key = scopedProjectKey(scopeProjectRef(environmentId, projectId));
  let ref = projectPanelRefs.get(key);
  if (!ref) {
    ref = scopeThreadRef(environmentId, ThreadId.make(`project-panel:${projectId}`));
    projectPanelRefs.set(key, ref);
  }
  return ref;
}

/** The ref whose right panel, terminal drawer and terminals `ref` shows: its project's, or its own. */
export function panelScopeRef(ref: ScopedThreadRef): ScopedThreadRef {
  return resolveSharedPanel(ref) ?? ref;
}

export function panelScopeKey(ref: ScopedThreadRef): string {
  return scopedThreadKey(panelScopeRef(ref));
}
