import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  canCurrentMemberChangeThreadView,
  canCurrentMemberInterruptThread,
  canCurrentMemberLeaveThreadNote,
  canCurrentMemberToggleThreadLock,
  hasActiveTeamEnvironment,
  isFollowingTeamThread,
  isTeamColleagueThread,
  isTeamThreadLocked,
  listAccessibleTeamViews,
  resolveTeamThreadEnvironmentAccessForClient,
  resolveTeamThreadView,
} from "@t3tools/client-runtime/team";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BellOffIcon,
  BookOpenIcon,
  CloudIcon,
  GitBranchIcon,
  GitForkIcon,
  LayersIcon,
  LockIcon,
  OctagonXIcon,
  StickyNoteIcon,
  UnlockIcon,
  UsersIcon,
} from "lucide-react";

import { useEnvironmentScope } from "~/state/session";
import { useProjects, useQuietThreadShell } from "~/state/entities";
import {
  cycleTeamSidebarFilterMode,
  openTeamForkDialog,
  setTeamThreadNoteMode,
  teamEnvironment,
  toggleShowColleaguesThreads,
  toggleShowFollowedThreadsOnly,
  useTeamSidebarFilterMode,
  useTeamThreadLocation,
  useTeamStatesByEnvironment,
  type TeamSidebarFilterMode,
} from "~/state/team";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { useTeamThreadAccessActions } from "./useTeamThreadAccessActions";
import { useTeamThreadFollowToggle } from "./useTeamThreadFollowToggle";

export function useTeamCommandPaletteActions(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const navigate = useNavigate();
  const teamStatesByEnvironment = useTeamStatesByEnvironment();
  const sidebarFilterMode = useTeamSidebarFilterMode();
  const showColleaguesThreads = sidebarFilterMode === "all";
  const showFollowedThreadsOnly = sidebarFilterMode === "followed";
  const { setFollowing: setTeamThreadFollowing } = useTeamThreadFollowToggle();
  const { setThreadView, setThreadLocked } = useTeamThreadAccessActions();
  const activeLocation = useTeamThreadLocation(
    activeThread?.environmentId ?? null,
    activeThread?.id ?? null,
  );
  const activeTeamState = activeThread
    ? teamStatesByEnvironment.get(activeThread.environmentId)
    : undefined;
  const canFollowActiveThread = activeLocation !== null && isTeamColleagueThread(activeLocation);
  const isFollowingActiveThread = activeLocation !== null && isFollowingTeamThread(activeLocation);
  const canToggleActiveThreadFollow = useAtomValue(
    (isFollowingActiveThread
      ? teamEnvironment.unfollowThread
      : teamEnvironment.followThread
    ).permissionAtom(activeLocation?.teamEnvironmentId ?? null),
  );
  const canSetViewScope = useAtomValue(
    teamEnvironment.setThreadView.permissionAtom(activeThread?.environmentId ?? null),
  );
  const canSetLockScope = useAtomValue(
    teamEnvironment.setThreadLocked.permissionAtom(activeThread?.environmentId ?? null),
  );
  const canOperateActiveThread = useEnvironmentScope(
    activeThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const activeThreadShell = useQuietThreadShell(
    activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null,
  );
  const allProjects = useProjects();
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const items: CommandPaletteActionItem[] = [];
  if (canFollowActiveThread && canToggleActiveThreadFollow && activeThread) {
    items.push({
      kind: "action",
      value: "action:team-toggle-follow",
      searchTerms: [
        "team",
        "follow",
        "unfollow",
        "notifications",
        "bell",
        "subscribe",
        "mute",
        "thread",
      ],
      title: isFollowingActiveThread ? gt("Unfollow current thread") : gt("Follow current thread"),
      icon: isFollowingActiveThread ? (
        <BellOffIcon className={ITEM_ICON_CLASS} />
      ) : (
        <BellIcon className={ITEM_ICON_CLASS} />
      ),
      run: async () => {
        await setTeamThreadFollowing({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          follow: !isFollowingActiveThread,
        });
      },
    });
  }
  if (activeThread && activeTeamState?.team != null) {
    const envAccess = resolveTeamThreadEnvironmentAccessForClient({
      teamState: activeTeamState,
      threadId: activeThread.id,
      viewingOnLocalExecutionEnvironment: false,
    });
    const activeRunId = activeThreadShell?.runtime?.activeRunId ?? null;
    if (activeRunId !== null && canOperateActiveThread && envAccess.canExecute) {
      const interruptPermission = canCurrentMemberInterruptThread({
        teamState: activeTeamState,
        threadId: activeThread.id,
        activeRunId,
      });
      if (interruptPermission.isExplicitAdminInterrupt) {
        items.push({
          kind: "action",
          value: "action:team-interrupt-turn",
          searchTerms: [
            "team",
            "interrupt",
            "stop",
            "cancel",
            "admin",
            "owner",
            "modo",
            "moderator",
            "turn",
          ],
          title: gt("Interrupt active turn"),
          icon: <OctagonXIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await interruptThreadTurn({
              environmentId: activeThread.environmentId,
              input: { threadId: activeThread.id },
            });
          },
        });
      }
    }
    if (canSetLockScope && canCurrentMemberToggleThreadLock(activeTeamState)) {
      const isLocked = isTeamThreadLocked({
        teamState: activeTeamState,
        threadId: activeThread.id,
      });
      items.push({
        kind: "action",
        value: "action:team-toggle-lock",
        searchTerms: ["team", "lock", "unlock", "read-only", "admin", "owner", "thread"],
        title: isLocked ? gt("Unlock current thread") : gt("Lock current thread"),
        icon: isLocked ? (
          <UnlockIcon className={ITEM_ICON_CLASS} />
        ) : (
          <LockIcon className={ITEM_ICON_CLASS} />
        ),
        run: async () => {
          await setThreadLocked({
            environmentId: activeThread.environmentId,
            threadId: activeThread.id,
            locked: !isLocked,
          });
        },
      });
    }
    if (canSetViewScope && canCurrentMemberChangeThreadView(activeTeamState)) {
      const currentView = resolveTeamThreadView({
        teamState: activeTeamState,
        threadId: activeThread.id,
      });
      const accessibleViews = listAccessibleTeamViews(activeTeamState);
      for (const view of accessibleViews) {
        if (view.id === currentView?.id) continue;
        items.push({
          kind: "action",
          value: `action:team-move-view:${view.id}`,
          searchTerms: ["team", "view", "move", "access", "visibility", view.name],
          title: gt("Move current thread to view: {viewName}", { viewName: view.name }),
          icon: <LayersIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await setThreadView({
              environmentId: activeThread.environmentId,
              threadId: activeThread.id,
              viewId: view.id,
            });
          },
        });
      }
    }
    if (!envAccess.canExecute && activeThreadShell) {
      const threadProject = allProjects.find(
        (p) =>
          p.environmentId === activeThread.environmentId && p.id === activeThreadShell.projectId,
      );
      items.push({
        kind: "action",
        value: "action:team-fork-thread",
        searchTerms: ["team", "fork", "environment", "handoff", "copy", "thread"],
        title: gt("Fork this thread to an accessible environment"),
        icon: <GitForkIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          openTeamForkDialog({
            sourceEnvironmentId: activeThread.environmentId,
            sourceThreadId: activeThread.id,
            sourceThreadTitle: activeThreadShell.title,
            teamEnvironmentId: activeThread.environmentId,
            projectId: activeThreadShell.projectId,
            repositoryIdentity: threadProject?.repositoryIdentity,
          });
        },
      });
      if (
        canCurrentMemberLeaveThreadNote({ teamState: activeTeamState, threadId: activeThread.id })
      ) {
        items.push({
          kind: "action",
          value: "action:team-leave-note",
          searchTerms: ["team", "note", "comment", "suggest", "thread"],
          title: gt("Leave a note on this thread"),
          icon: <StickyNoteIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            setTeamThreadNoteMode(
              scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id)),
              true,
            );
          },
        });
      }
    }
  }
  if (hasActiveTeamEnvironment(teamStatesByEnvironment)) {
    const filterModeLabel = (mode: TeamSidebarFilterMode): string => {
      if (mode === "mine") return gt("My threads");
      if (mode === "followed") return gt("Followed");
      return gt("All team");
    };
    const nextCycleMode: TeamSidebarFilterMode =
      sidebarFilterMode === "mine" ? "followed" : sidebarFilterMode === "followed" ? "all" : "mine";
    items.push({
      kind: "action",
      value: "action:team-cycle-sidebar-filter",
      searchTerms: [
        "team",
        "filter",
        "sidebar",
        "threads",
        "my threads",
        "followed",
        "all team",
        "cycle",
      ],
      title: gt("Team thread filter: switch to {next} (currently {current})", {
        next: filterModeLabel(nextCycleMode),
        current: filterModeLabel(sidebarFilterMode),
      }),
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        cycleTeamSidebarFilterMode();
      },
    });
    items.push({
      kind: "action",
      value: "action:team-toggle-colleagues",
      searchTerms: ["team", "colleagues", "members", "filter", "sidebar", "threads", "pseudo"],
      title: showColleaguesThreads
        ? gt("Filter sidebar to my threads")
        : gt("Show all team threads"),
      shortcutCommand: "team.toggleColleagues",
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        toggleShowColleaguesThreads();
      },
    });
    items.push({
      kind: "action",
      value: "action:team-toggle-followed-filter",
      searchTerms: ["team", "followed", "following", "filter", "sidebar", "notifications"],
      title: showFollowedThreadsOnly
        ? gt("Filter sidebar to my threads")
        : gt("Filter sidebar to followed threads"),
      icon: <BellIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        toggleShowFollowedThreadsOnly();
      },
    });
    items.push({
      kind: "action",
      value: "action:team-open-github",
      searchTerms: ["team", "github", "pat", "token", "identity", "commit", "automation"],
      title: gt("Open Team GitHub Identity settings"),
      icon: <GitBranchIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/teams", hash: "teams-github" });
      },
    });
    items.push({
      kind: "action",
      value: "action:team-open-providers",
      searchTerms: ["team", "providers", "models", "api key", "oauth", "proxy", "lease"],
      title: gt("Open Team Providers settings"),
      icon: <CloudIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/teams", hash: "teams-providers" });
      },
    });
    items.push({
      kind: "action",
      value: "action:team-open-skills",
      searchTerms: ["team", "skills", "preprompts", "instructions", "markdown"],
      title: gt("Open Team Skills & Pre-prompts settings"),
      icon: <BookOpenIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/teams", hash: "teams-skills" });
      },
    });
  }
  return items;
}
