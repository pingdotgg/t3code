import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ShellSidebarDraft, ShellSidebarState } from "@t3tools/contracts/shell";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { partitionSidebarThreads } from "../components/Sidebar.logic";
import { openCommandPalette } from "../commandPaletteBus";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { requestShellRename } from "./shellRenameRequest";
import { environmentServerConfigsAtom } from "../state/server";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { buildLogicalProjectKeyMap, buildShellSidebarState } from "./shellSidebarState";
import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

/**
 * Feeds the native shell (window.t3Shell) the sidebar view model and turns
 * its actions into navigation. Mounted only when hosted by the shell; the
 * HTML sidebar hides itself in that case (AppSidebarLayout). Everything here
 * is derived with the same logic the HTML sidebar uses, so the two never
 * disagree about rows, order, or status.
 */
export function T3ShellBridge() {
  const router = useRouter();
  const threads = useThreadShells();
  const { projectGroups } = useSidebarProjectGroups(threads);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const nowMinute = useNowMinute();
  const lastVisitedAtByKey = useUiStateStore((store) => store.threadLastVisitedAtById);
  const handleNewThread = useNewThreadHandler();
  const [scopeProjectKey, setScopeProjectKey] = useState<string | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const [menuTarget, setMenuTarget] = useState<{
    key: string;
    x: number;
    y: number;
    seq: number;
  } | null>(null);
  const menuThreadRef = menuTarget ? parseScopedThreadKey(menuTarget.key) : null;
  const menuThreadShell = useMemo(
    () =>
      menuThreadRef
        ? threads.find(
            (thread) =>
              thread.environmentId === menuThreadRef.environmentId &&
              thread.id === menuThreadRef.threadId,
          )
        : undefined,
    [menuThreadRef, threads],
  );
  const menuProjectCwd = useMemo(() => {
    if (!menuThreadShell) return null;
    for (const group of projectGroups) {
      const member = group.memberProjects.find(
        (project) =>
          project.environmentId === menuThreadShell.environmentId &&
          project.id === menuThreadShell.projectId,
      );
      if (member) return member.workspaceRoot;
    }
    return null;
  }, [menuThreadShell, projectGroups]);
  const { openMenu: openThreadMenu } = useThreadActionMenu({
    threadRef: menuThreadRef,
    projectCwd: menuProjectCwd,
    onStartRename: () => {
      if (!menuThreadRef) return;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(menuThreadRef),
      });
      // The workspace bridge for that thread claims the request once mounted.
      requestShellRename(scopedThreadKey(menuThreadRef));
    },
  });
  useEffect(() => {
    if (!menuTarget || !menuThreadRef) return;
    void Promise.resolve().then(() => {
      openThreadMenu({ x: menuTarget.x, y: menuTarget.y, surface: "shell" });
    });
    // Only re-open for a new request, not for hook identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuTarget?.seq]);
  const draftSessions = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftContents = useComposerDraftStore((store) => store.draftsByThreadKey);

  const scopedGroup = useMemo(
    () =>
      scopeProjectKey === null
        ? null
        : (projectGroups.find((group) => group.projectKey === scopeProjectKey) ?? null),
    [projectGroups, scopeProjectKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedGroup === null
        ? null
        : new Set(
            scopedGroup.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
          ),
    [scopedGroup],
  );
  useEffect(() => {
    if (scopeProjectKey !== null && scopedGroup === null) {
      setScopeProjectKey(null);
    }
  }, [scopeProjectKey, scopedGroup]);

  const partition = useMemo(
    () =>
      partitionSidebarThreads({
        threads,
        scopedProjectKeys,
        capabilitiesFor: (environmentId) =>
          serverConfigs.get(environmentId)?.environment.capabilities,
        preciseNow: new Date().toISOString(),
      }),
    // nowMinute re-runs the partition so snoozed threads wake on time.
    [nowMinute, scopedProjectKeys, serverConfigs, threads],
  );

  const threadCountByLogicalKey = useMemo(() => {
    const logicalKeyByPhysicalKey = buildLogicalProjectKeyMap(projectGroups);
    const counts = new Map<string, number>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const key = logicalKeyByPhysicalKey.get(`${thread.environmentId}:${thread.projectId}`);
      if (key === undefined) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [projectGroups, threads]);

  const drafts = useMemo((): ReadonlyArray<ShellSidebarDraft> => {
    const logicalKeyByPhysicalKey = buildLogicalProjectKeyMap(projectGroups);
    const result: ShellSidebarDraft[] = [];
    for (const [draftId, session] of Object.entries(draftSessions)) {
      if (session.promotedTo != null) continue;
      if (!composerDraftHasUserContent(draftContents[draftId])) continue;
      const physicalKey = `${session.environmentId}:${session.projectId}`;
      if (scopedProjectKeys !== null && !scopedProjectKeys.has(physicalKey)) continue;
      result.push({
        draftId,
        projectKey: logicalKeyByPhysicalKey.get(physicalKey) ?? physicalKey,
        label: "Draft",
      });
    }
    return result;
  }, [draftContents, draftSessions, projectGroups, scopedProjectKeys]);

  const state = useMemo(
    (): ShellSidebarState =>
      buildShellSidebarState({
        projectGroups,
        scopeProjectKey,
        partition,
        threadCountByLogicalKey,
        lastVisitedAtByKey,
        drafts,
        activeThreadKey:
          routeTarget?.kind === "server"
            ? `${routeTarget.threadRef.environmentId}:${routeTarget.threadRef.threadId}`
            : null,
        activeDraftId: routeTarget?.kind === "draft" ? routeTarget.draftId : null,
      }),
    [
      drafts,
      lastVisitedAtByKey,
      partition,
      projectGroups,
      routeTarget,
      scopeProjectKey,
      threadCountByLogicalKey,
    ],
  );

  useShellPublish("sidebar", state);

  useShellActions((action) => {
    switch (action.type) {
      case "thread.open": {
        const threadRef = parseScopedThreadKey(action.key);
        if (threadRef === null) return;
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return;
      }
      case "draft.open":
        void router.navigate({
          to: "/draft/$draftId",
          params: { draftId: DraftId.make(action.draftId) },
        });
        return;
      case "thread.new": {
        const group =
          action.projectKey === undefined
            ? projectGroups[0]
            : projectGroups.find((item) => item.projectKey === action.projectKey);
        if (group === undefined) {
          // A stale key (project removed, environment gone) must not land
          // the thread in whichever project sorts first.
          if (action.projectKey === undefined) openCommandPalette({ open: "add-project" });
          return;
        }
        void handleNewThread(scopeProjectRef(group.environmentId, group.id));
        return;
      }
      case "sidebar.scope":
        setScopeProjectKey(action.projectKey);
        return;
      case "thread.menu":
        setMenuTarget((prev) => ({
          key: action.key,
          x: action.x,
          y: action.y,
          seq: (prev?.seq ?? 0) + 1,
        }));
        return;
      case "project.add":
        openCommandPalette({ open: "add-project" });
        return;
      case "palette.open":
        openCommandPalette({});
        return;
      case "settings.open":
        void router.navigate({ to: "/settings" });
        return;
      case "pullRequests.open":
        void router.navigate({
          to: "/pull-requests",
          search: { involvement: "all", state: "open" },
        });
        return;
      case "usage.open":
        void router.navigate({ to: "/usage" });
        return;
    }
  });

  return null;
}
