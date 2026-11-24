import { useAtomValue } from "@effect/atom-react";
import { hasActiveTeamEnvironment } from "@t3tools/client-runtime/team";
import { useGT } from "gt-react";
import { UsersIcon } from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  toggleShowColleaguesThreads,
  useShowColleaguesThreads,
  useTeamStatesByEnvironment,
} from "~/state/team";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";

export function TeamColleaguesToggle() {
  const gt = useGT();
  const teamStates = useTeamStatesByEnvironment();
  const showColleagues = useShowColleaguesThreads();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!hasActiveTeamEnvironment(teamStates)) return null;

  const shortcut = shortcutLabelForCommand(keybindings, "team.toggleColleagues");
  const baseLabel = showColleagues
    ? gt("Hide colleagues' threads")
    : gt("Show colleagues' threads");
  const tooltip = shortcut ? `${baseLabel} (${shortcut})` : baseLabel;

  return (
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
  );
}
