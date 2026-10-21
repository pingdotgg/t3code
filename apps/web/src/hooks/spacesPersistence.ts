import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { transferDraftSpace } from "./spaces.logic";
import type { SpacesState } from "@t3tools/contracts/settings";
import type { ProjectId, ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  assignNewThreadSpace,
  assignProjectSpace,
  assignThreadSpace,
} from "@t3tools/client-runtime/state/spaces";
import { getClientSettings, persistClientSettingsUpdate } from "./useSettings";
import { toastManager } from "../components/ui/toast";

export function updateSpaces(update: (state: SpacesState) => SpacesState) {
  return persistClientSettingsUpdate((settings) => ({
    ...settings,
    spaces: update(settings.spaces),
  }));
}

export function reportSpaceError(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not save Spaces",
    description: error instanceof Error ? error.message : "Try again.",
  });
}

export function captureActiveSpace() {
  return getClientSettings().spaces.activeSpaceId;
}

// The project or thread already exists when these run, so a failed save only
// toasts instead of rejecting and stopping the caller's create flow.
export function assignCreatedProjectSpace(ref: ScopedProjectRef, spaceId: string | null) {
  return updateSpaces((state) => assignProjectSpace(state, ref, spaceId)).then(
    () => undefined,
    reportSpaceError,
  );
}

export function assignCreatedThreadSpace(
  ref: ScopedThreadRef,
  spaceId: string | null,
  projectId: ProjectId,
) {
  return updateSpaces((state) =>
    assignNewThreadSpace(
      state,
      { environmentId: ref.environmentId, id: ref.threadId, projectId },
      spaceId,
    ),
  ).then(() => undefined, reportSpaceError);
}

export function threadSpaceMenu(ref: ScopedThreadRef) {
  const state = getClientSettings().spaces;
  const key = scopedThreadKey(ref);
  const inherited = !Object.hasOwn(state.threadSpaces, key);
  const membership = state.threadSpaces[key];
  return {
    id: "space:menu" as const,
    label: "Move to Space",
    children: [
      { id: "space:inherit" as const, label: "Inherit from project", checked: inherited },
      { id: "space:none" as const, label: "No Space", checked: !inherited && membership === null },
      ...state.spaces.map((space) => ({
        id: `space:${space.id}` as const,
        label: space.name,
        checked: !inherited && membership === space.id,
      })),
    ],
  };
}

export function isSpaceMenuAction(action: string): action is `space:${string}` {
  return action.startsWith("space:");
}

export function runThreadSpaceAction(ref: ScopedThreadRef, action: `space:${string}`) {
  const id = action.slice("space:".length);
  return updateSpaces((state) =>
    assignThreadSpace(state, ref, id === "inherit" ? undefined : id === "none" ? null : id),
  );
}

/** Keep draft work in its context when changing its destination. */
export function preserveDraftSpace(
  previous:
    | {
        environmentId: ScopedThreadRef["environmentId"];
        threadId: ScopedThreadRef["threadId"];
        projectId: ProjectId;
      }
    | undefined,
  next: ScopedProjectRef & { readonly threadId: ScopedThreadRef["threadId"] },
) {
  if (
    !previous ||
    (previous.environmentId === next.environmentId &&
      previous.projectId === next.projectId &&
      previous.threadId === next.threadId)
  )
    return;
  void updateSpaces((state) =>
    transferDraftSpace(state, previous, {
      ...scopeThreadRef(next.environmentId, next.threadId),
      projectId: next.projectId,
    }),
  ).catch(reportSpaceError);
}
