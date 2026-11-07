import { AGENT_MERGE_OPTIONS } from "@t3tools/client-runtime/thread-pull-requests";
import type { ThreadPullRequestAgentMerge } from "@t3tools/contracts";

import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";

export function AgentMergeMenuItems({
  active,
  onSelect,
}: {
  active: ThreadPullRequestAgentMerge | undefined;
  onSelect: (agentMerge: ThreadPullRequestAgentMerge) => void;
}) {
  return (
    <MenuRadioGroup
      value={active ?? null}
      onValueChange={(value) => onSelect(value as ThreadPullRequestAgentMerge)}
    >
      {AGENT_MERGE_OPTIONS.map((option) => (
        <MenuRadioItem key={option.value} value={option.value} closeOnClick>
          {option.label}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}
