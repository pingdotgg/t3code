import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ShellAction, type ShellSidebarDraft, type ShellSidebarState } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { partitionSidebarThreads } from "../components/Sidebar.logic";
import { openCommandPalette } from "../commandPaletteBus";
import { composerDraftHasUserContent, useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { environmentServerConfigsAtom } from "../state/server";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { buildLogicalProjectKeyMap, buildShellSidebarState } from "./shellSidebarState";

const isShellAction = Schema.is(ShellAction);

/**
 * Feeds the native shell (window.t3Shell) the sidebar view model and turns
 * its actions into navigation. Mounted only when hosted by the shell; the
 * HTML sidebar hides itself in that case (AppSidebarLayout). Everything here
 * is derived with the same logic the HTML sidebar uses, so the two never
 * disagree about rows, order, or status.
 */
export function T3ShellBridge() {
  const shell = window.t3Shell;
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

  useEffect(() => {
    if (!shell) return;
    void shell.publish("sidebar", state);
  }, [shell, state]);

  // The shell subscribes once; handlers read the latest values through a ref.
  const latest = useRef({ projectGroups, router, handleNewThread });
  latest.current = { projectGroups, router, handleNewThread };
  useEffect(() => {
    if (!shell) return;
    void shell.onAction((type, payload) => {
      const candidate = {
        ...(typeof payload === "object" && payload !== null ? payload : {}),
        type,
      };
      if (!isShellAction(candidate)) return;
      const {
        projectGroups: groups,
        router: currentRouter,
        handleNewThread: newThread,
      } = latest.current;
      switch (candidate.type) {
        case "thread.open": {
          const threadRef = parseScopedThreadKey(candidate.key);
          if (threadRef === null) return;
          void currentRouter.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
          return;
        }
        case "draft.open":
          void currentRouter.navigate({
            to: "/draft/$draftId",
            params: { draftId: candidate.draftId as never },
          });
          return;
        case "thread.new": {
          const group =
            (candidate.projectKey === undefined
              ? groups[0]
              : groups.find((item) => item.projectKey === candidate.projectKey)) ?? groups[0];
          if (group === undefined) {
            openCommandPalette({ open: "add-project" });
            return;
          }
          void newThread(scopeProjectRef(group.environmentId, group.id));
          return;
        }
        case "sidebar.scope":
          setScopeProjectKey(candidate.projectKey);
          return;
        case "project.add":
          openCommandPalette({ open: "add-project" });
          return;
        case "palette.open":
          openCommandPalette({});
          return;
        case "settings.open":
          void currentRouter.navigate({ to: "/settings" });
          return;
        case "pullRequests.open":
          void currentRouter.navigate({
            to: "/pull-requests",
            search: { involvement: "all", state: "open" },
          });
          return;
        case "usage.open":
          void currentRouter.navigate({ to: "/usage" });
          return;
      }
    });
  }, [shell]);

  return null;
}
