import { useComposerDraftStore } from "../composerDraftStore";
import { preserveDraftSpace } from "../hooks/spacesPersistence";
import { useEffect, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isThreadInSpace, rememberSpaceThread } from "@t3tools/client-runtime/state/spaces";
import { useClientSettings } from "../hooks/useSettings";
import { updateSpaces, reportSpaceError, isSpaceSwitching } from "../hooks/useSpaces";
import { setSpaceThemeOverlay } from "../hooks/useTheme";
import { useThreadShell } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";

export function SpaceCoordinator() {
  const spaces = useClientSettings((settings) => settings.spaces);
  const activeTheme =
    spaces.spaces.find((space) => space.id === spaces.activeSpaceId)?.theme ?? null;
  const route = useParams({ strict: false, select: (params) => resolveThreadRouteTarget(params) });
  const ref = route?.kind === "server" ? route.threadRef : null;
  const thread = useThreadShell(ref);
  const previousSpace = useRef(spaces.activeSpaceId);
  useEffect(() => {
    setSpaceThemeOverlay(activeTheme);
  }, [activeTheme]);
  useEffect(() => () => setSpaceThemeOverlay(null), []);
  useEffect(
    () =>
      useComposerDraftStore.subscribe((state, previous) => {
        if (state.draftThreadsByThreadKey === previous.draftThreadsByThreadKey) return;
        for (const [key, draft] of Object.entries(state.draftThreadsByThreadKey)) {
          preserveDraftSpace(previous.draftThreadsByThreadKey[key], {
            environmentId: draft.environmentId,
            projectId: draft.projectId,
            threadId: draft.threadId,
          });
        }
      }),
    [],
  );
  useEffect(() => {
    if (previousSpace.current !== spaces.activeSpaceId) {
      previousSpace.current = spaces.activeSpaceId;
      return;
    }
    if (
      isSpaceSwitching() ||
      !ref ||
      !thread ||
      thread.archivedAt ||
      !isThreadInSpace(spaces, thread)
    )
      return;
    const remembered = spaces.lastThreadBySpace[spaces.activeSpaceId ?? "all"];
    if (remembered && scopedThreadKey(remembered) === scopedThreadKey(ref)) return;
    const spaceId = spaces.activeSpaceId;
    void updateSpaces((state) =>
      state.activeSpaceId === spaceId && isThreadInSpace(state, thread)
        ? rememberSpaceThread(state, ref)
        : state,
    ).catch(reportSpaceError);
  }, [ref, spaces, thread]);
  return null;
}
