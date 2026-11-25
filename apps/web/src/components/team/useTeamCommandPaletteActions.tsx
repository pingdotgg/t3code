import { useAtomValue } from "@effect/atom-react";
import {
  canCurrentMemberChangeThreadView,
  canCurrentMemberToggleThreadLock,
  hasActiveTeamEnvironment,
  isFollowingTeamThread,
  isTeamColleagueThread,
  isTeamThreadLocked,
  listAccessibleTeamViews,
  resolveTeamThreadView,
} from "@t3tools/client-runtime/team";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BellIcon, BellOffIcon, LayersIcon, LockIcon, UnlockIcon, UsersIcon } from "lucide-react";

import {
  teamEnvironment,
  toggleShowColleaguesThreads,
  toggleShowFollowedThreadsOnly,
  useShowColleaguesThreads,
  useShowFollowedThreadsOnly,
  useTeamStatesByEnvironment,
} from "~/state/team";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { useTeamThreadAccessActions } from "./useTeamThreadAccessActions";
import { useTeamThreadFollowToggle } from "./useTeamThreadFollowToggle";

export function useTeamCommandPaletteActions(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const teamStatesByEnvironment = useTeamStatesByEnvironment();
  const showColleaguesThreads = useShowColleaguesThreads();
  const showFollowedThreadsOnly = useShowFollowedThreadsOnly();
  const { setFollowing: setTeamThreadFollowing } = useTeamThreadFollowToggle();
  const { setThreadView, setThreadLocked } = useTeamThreadAccessActions();
  const activeTeamState = activeThread
    ? teamStatesByEnvironment.get(activeThread.environmentId)
    : undefined;
  const canFollowActiveThread =
    activeThread !== null &&
    activeThread !== undefined &&
    isTeamColleagueThread({ teamState: activeTeamState, threadId: activeThread.id });
  const isFollowingActiveThread =
    canFollowActiveThread &&
    isFollowingTeamThread({ teamState: activeTeamState, threadId: activeThread.id });
  const canToggleActiveThreadFollow = useAtomValue(
    (isFollowingActiveThread
      ? teamEnvironment.unfollowThread
      : teamEnvironment.followThread
    ).permissionAtom(activeThread?.environmentId ?? null),
  );
  const canSetViewScope = useAtomValue(
    teamEnvironment.setThreadView.permissionAtom(activeThread?.environmentId ?? null),
  );
  const canSetLockScope = useAtomValue(
    teamEnvironment.setThreadLocked.permissionAtom(activeThread?.environmentId ?? null),
  );

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
  }
  if (hasActiveTeamEnvironment(teamStatesByEnvironment)) {
    items.push({
      kind: "action",
      value: "action:team-toggle-colleagues",
      searchTerms: ["team", "colleagues", "members", "filter", "sidebar", "threads", "pseudo"],
      title: showColleaguesThreads
        ? gt("Hide colleagues' threads")
        : gt("Show colleagues' threads"),
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
        ? gt("Show all visible team threads")
        : gt("Filter sidebar to followed threads"),
      icon: <BellIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        toggleShowFollowedThreadsOnly();
      },
    });
  }
  return items;
}
