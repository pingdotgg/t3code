import { useAtomValue } from "@effect/atom-react";

import type { AgentTabRef } from "./browserTabs";
import { threadSessionsAtom } from "./previewStream";

/** One agent's browser tabs, a row each. An agent with none shows nothing. */
export function ThreadTabs({
  threadId,
  title,
  selected,
  onSelect,
}: {
  threadId: string;
  title: string;
  selected: AgentTabRef | null;
  onSelect: (target: AgentTabRef) => void;
}) {
  const sessions = useAtomValue(threadSessionsAtom(threadId));
  return sessions.map(({ navStatus, tabId }) => {
    const url = navStatus._tag === "Idle" ? "" : navStatus.url;
    const pageTitle = navStatus._tag === "Idle" ? "" : navStatus.title;
    const isSelected = selected?.threadId === threadId && selected.tabId === tabId;
    return (
      <button
        key={tabId}
        type="button"
        data-testid="agent-tab"
        data-url={url}
        aria-pressed={isSelected}
        onClick={() => onSelect({ threadId, tabId })}
        className={`flex w-full min-w-0 flex-col rounded-md px-2 py-1 text-left hover:bg-hover ${isSelected ? "bg-hover" : ""}`}
      >
        <span className="truncate text-[12px] text-fg">{pageTitle || url || "Blank tab"}</span>
        <span className="truncate text-[11px] text-muted">
          {title}
          {url !== "" && pageTitle !== "" ? ` · ${url}` : ""}
        </span>
      </button>
    );
  });
}
