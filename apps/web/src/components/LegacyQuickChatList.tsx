import { useState } from "react";
import { cn } from "../lib/utils";
import { useNavigate, useParams } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useThreadShells } from "../state/entities";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "../state/threads";
import { Input } from "./ui/input";
import { useSidebar } from "./ui/sidebar";

function QuickChatRow({ thread, selected }: { thread: EnvironmentThreadShell; selected: boolean }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const update = useAtomCommand(threadEnvironment.updateMetadata, "Rename quick chat");
  const { openMenu } = useThreadActionMenu({
    threadRef: scopeThreadRef(thread.environmentId, thread.id),
    projectCwd: null,
    onStartRename: () => {
      setTitle(thread.title);
      setRenaming(true);
    },
  });
  return (
    <li>
      {renaming ? (
        <Input
          aria-label="Chat title"
          size="compact"
          className="w-full"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") setRenaming(false);
            if (event.key === "Enter" && title.trim())
              void update({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, title: title.trim() },
              }).then((result) => {
                if (result._tag === "Success") setRenaming(false);
              });
          }}
        />
      ) : (
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          className={cn(
            "w-full truncate px-2 py-1.5 text-left text-sm hover:bg-sidebar-row-hover",
            selected && "bg-sidebar-row-hover text-white",
          )}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: thread.environmentId, threadId: thread.id },
            });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {thread.title}
        </button>
      )}
    </li>
  );
}

export function LegacyQuickChatList() {
  const route = useParams({ strict: false });
  const threads = useThreadShells()
    .filter((thread) => thread.projectId === null && thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (threads.length === 0) return null;
  return (
    <div className="pt-4">
      <div className="px-2 pb-1 text-xs font-medium">Quick chats</div>
      <ul>
        {threads.map((thread) => (
          <QuickChatRow
            key={`${thread.environmentId}:${thread.id}`}
            thread={thread}
            selected={route.environmentId === thread.environmentId && route.threadId === thread.id}
          />
        ))}
      </ul>
    </div>
  );
}
