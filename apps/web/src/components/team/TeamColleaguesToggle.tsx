import { useAtomValue } from "@effect/atom-react";
import { hasActiveTeamEnvironment } from "@t3tools/client-runtime/team";
import { useGT } from "gt-react";
import { BellIcon, UsersIcon } from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  toggleShowColleaguesThreads,
  toggleShowFollowedThreadsOnly,
  useShowColleaguesThreads,
  useShowFollowedThreadsOnly,
  useTeamFollowedThreadCount,
  useTeamStatesByEnvironment,
} from "~/state/team";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";

export function TeamColleaguesToggle() {
  const gt = useGT();
  const teamStates = useTeamStatesByEnvironment();
  const showColleagues = useShowColleaguesThreads();
  const showFollowedOnly = useShowFollowedThreadsOnly();
  const followedCount = useTeamFollowedThreadCount();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!hasActiveTeamEnvironment(teamStates)) return null;

  const shortcut = shortcutLabelForCommand(keybindings, "team.toggleColleagues");
  const baseLabel = showColleagues
    ? gt("Hide colleagues' threads")
    : gt("Show colleagues' threads");
  const tooltip = shortcut ? `${baseLabel} (${shortcut})` : baseLabel;

  const followedLabel = showFollowedOnly
    ? gt("Show all visible team threads")
    : followedCount > 0
      ? gt("Filter to followed threads ({count})", { count: followedCount })
      : gt("Filter to followed threads");

  return (
    <>
      <SidebarHeaderIconButton
        data-testid="team-followed-filter-toggle"
        aria-pressed={showFollowedOnly}
        variant={showFollowedOnly ? "outline" : "default"}
        label={followedLabel}
        tooltip={followedLabel}
        onClick={() => {
          toggleShowFollowedThreadsOnly();
        }}
      >
        <BellIcon />
        {followedCount > 0 ? (
          <span
            aria-hidden
            data-testid="team-followed-count-badge"
            className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-4xs leading-3.5 font-semibold text-primary-foreground tabular-nums"
          >
            {followedCount > 9 ? "9+" : followedCount}
          </span>
        ) : null}
      </SidebarHeaderIconButton>
      <SidebarHeaderIconButton
        data-testid="team-colleagues-toggle"
        aria-pressed={showColleagues}
        variant={showColleagues ? "outline" : "default"}
        label={baseLabel}
        tooltip={tooltip}
        onClick={() => {
          toggleShowColleaguesThreads();
        }}
      >
        <UsersIcon />
      </SidebarHeaderIconButton>
    </>
  );
}
