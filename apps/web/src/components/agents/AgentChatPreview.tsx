import { AgentPreviewReply } from "./AgentPreviewReply";
import { useLayoutEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProject, useThreadDetail, useThreadStatus } from "../../state/entities";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import ChatMarkdown from "../ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "../chat/MessagesTimeline.logic";
import { agentThreadStatus, agentThreadStatusLabel } from "./agents.logic";

export function AgentChatPreview({
  thread,
  project,
  onClose,
}: {
  thread: EnvironmentThreadShell;
  project: string;
  onClose: () => void;
}) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const detail = useThreadDetail(ref);
  const status = useThreadStatus(ref);
  const workspace = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const messages = detail?.messages.filter((message) => message.role !== "system").slice(-8) ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Markdown and images can grow after a stream event has rendered. Follow only
  // while the reader stays near the bottom; never pull them away from older text.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const follow = () => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <section aria-label="Chat preview" className="agent-preview-chat">
      <header className="agent-preview-header">
        <div className="flex items-start justify-between gap-2">
          <strong>{thread.title}</strong>
          <button type="button" aria-label="Close chat preview" onClick={onClose}>
            ×
          </button>
        </div>
        <span>
          {project} · {agentThreadStatusLabel(agentThreadStatus(thread))}
        </span>
      </header>
      <div
        ref={scrollRef}
        className="agent-preview-scroll"
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        <div ref={contentRef} className="agent-preview-messages">
          {status === "cached" && <p role="status">Offline · showing saved messages</p>}
          {!detail && (
            <p role="status">
              {status === "deleted"
                ? "This chat is no longer available."
                : "Loading recent messages…"}
            </p>
          )}
          {detail && messages.length === 0 && <p>No messages yet.</p>}
          {detail &&
            detail.messages.filter((message) => message.role !== "system").length >
              messages.length && (
              <p className="agent-preview-note">Recent messages · open chat for earlier history</p>
            )}
          {messages.map((message) => {
            const user = message.role === "user";
            const text = user
              ? deriveDisplayedUserMessageState(message.text).visibleText
              : message.text;
            return (
              <article
                key={message.id}
                className={user ? "agent-preview-user" : "agent-preview-assistant"}
                aria-label={user ? "User message" : "Assistant message"}
              >
                <div className="agent-preview-role">
                  {user ? "You" : (thread.profileSnapshot?.profileName ?? "Agent")}
                  {message.streaming ? " · writing…" : ""}
                </div>
                <ChatMarkdown
                  className={user ? "text-message-foreground" : ""}
                  text={text.slice(0, 24000)}
                  cwd={thread.worktreePath ?? workspace?.workspaceRoot}
                  threadRef={ref}
                  isStreaming={Boolean(message.streaming)}
                  lineBreaks={user || shouldPreserveAssistantLineBreaks(text)}
                />
                {text.length > 24000 && (
                  <p className="agent-preview-note">Open chat to read the rest of this message.</p>
                )}
                {message.attachments?.map((attachment) => (
                  <div className="agent-preview-note" key={attachment.id}>
                    {attachment.name}
                  </div>
                ))}
              </article>
            );
          })}
          {agentThreadStatus(thread) === "running" &&
            !messages.some((message) => message.streaming) && (
              <p role="status" className="agent-preview-note">
                Agent is working…
              </p>
            )}
        </div>
      </div>
      <AgentPreviewReply
        thread={thread}
        onSent={() => {
          following.current = true;
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }}
      />
      <footer className="agent-preview-footer">
        <Link
          to="/agents/$environmentId/$threadId"
          params={{ environmentId: thread.environmentId, threadId: thread.id }}
        >
          Open chat →
        </Link>
      </footer>
    </section>
  );
}
