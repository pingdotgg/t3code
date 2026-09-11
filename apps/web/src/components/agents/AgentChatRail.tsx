import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { isAgentChatInFocus } from "./agents.logic";
import { ThreadCard } from "./ThreadCard";
import { useAgentThreadContextMenu } from "./useAgentThreadContextMenu";

export function AgentChatRail({ current }: { current: ScopedThreadRef }) {
  const threads = useThreadShells();
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const onContextMenu = useAgentThreadContextMenu();
  const currentKey = scopedThreadKey(current);
  const visible = threads
    .filter((thread) => {
      if (!thread.profileSnapshot) return false;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return isAgentChatInFocus(thread, visited[key], key === currentKey);
    })
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <nav className="agent-chat-rail" aria-label="Active and unread agent chats">
      <div className="agent-chat-rail-label">Active & unread</div>
      <div className="agent-chat-rail-list">
        {visible.map((thread) => (
          <div
            key={`${thread.environmentId}:${thread.id}`}
            data-current={
              thread.environmentId === current.environmentId && thread.id === current.threadId
            }
          >
            <ThreadCard thread={thread} onContextMenu={onContextMenu} />
          </div>
        ))}
      </div>
    </nav>
  );
}
