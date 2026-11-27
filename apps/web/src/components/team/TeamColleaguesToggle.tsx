import { useAtomValue } from "@effect/atom-react";
import { countFollowedTeamThreads, hasActiveTeamEnvironment } from "@t3tools/client-runtime/team";
import { useGT } from "gt-react";
import { BellIcon, UsersIcon } from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  toggleShowColleaguesThreads,
  toggleShowFollowedThreadsOnly,
  useTeamSidebarFilterMode,
  useTeamStatesByEnvironment,
} from "~/state/team";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";

export function TeamColleaguesToggle() {
  const gt = useGT();
  const teamStates = useTeamStatesByEnvironment();
  const filterMode = useTeamSidebarFilterMode();
  const showColleagues = filterMode === "all";
  const showFollowedOnly = filterMode === "followed";
  const followedCount = countFollowedTeamThreads(teamStates);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!hasActiveTeamEnvironment(teamStates)) return null;

  const shortcut = shortcutLabelForCommand(keybindings, "team.toggleColleagues");
  const allTeamLabel = showColleagues
    ? gt("Show my threads only (currently: All team)")
    : gt("Show all team threads");
  const allTeamTooltip = shortcut ? `${allTeamLabel} (${shortcut})` : allTeamLabel;

  const followedLabel = showFollowedOnly
    ? gt("Show my threads only (currently: Followed)")
    : followedCount > 0
      ? gt("Show followed threads only ({count})", { count: followedCount })
      : gt("Show followed threads only");

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
        label={allTeamLabel}
        tooltip={allTeamTooltip}
        onClick={() => {
          toggleShowColleaguesThreads();
        }}
      >
        <UsersIcon />
      </SidebarHeaderIconButton>
    </>
  );
}
