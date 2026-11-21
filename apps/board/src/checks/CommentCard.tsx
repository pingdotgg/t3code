import { CommentEntry } from "./CommentEntry";
import type { ConversationItem } from "./conversation";

/** One conversation item as a card: a loose comment, or a review thread with its file, line, and replies. */
export function CommentCard({ item }: { item: ConversationItem }) {
  if (item.kind === "comment") {
    return (
      <li className="overflow-clip rounded-lg border border-line bg-panel">
        <CommentEntry comment={item.comment} />
      </li>
    );
  }
  const { thread } = item;
  return (
    <li data-testid="pr-thread" className="overflow-clip rounded-lg border border-line bg-panel">
      <p className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 font-mono text-[11px] text-muted">
        <span className="min-w-0 truncate">
          {thread.path ?? "Conversation"}
          {thread.line === null ? "" : `:${thread.line}`}
        </span>
        {thread.isResolved && <span className="shrink-0 text-emerald-300">Resolved</span>}
        {thread.isOutdated && <span className="shrink-0 text-faint">Outdated</span>}
      </p>
      <CommentEntry comment={item.root} />
      {item.replies.map((reply) => (
        <div key={reply.id} className="border-t border-line/60">
          <CommentEntry comment={reply} reply />
        </div>
      ))}
    </li>
  );
}
