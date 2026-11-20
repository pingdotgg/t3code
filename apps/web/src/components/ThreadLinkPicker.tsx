import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useProjects, useVisibleThreadShells } from "~/state/entities";
import { useThreadSearch } from "~/state/queries";

import { threadLinkMatcher } from "./ThreadLinkPicker.logic";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";

type ThreadShell = ReturnType<typeof useVisibleThreadShells>[number];

/** Search over an environment's unarchived threads, to link one to a pull request or an issue. */
export function ThreadLinkPicker({
  environmentId,
  pending,
  isLinked,
  onSelect,
}: {
  environmentId: EnvironmentId;
  pending: boolean;
  isLinked: (thread: ThreadShell) => boolean;
  onSelect: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const threads = useVisibleThreadShells();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  // Mounts older settled threads matching the query, which shells may leave out.
  useThreadSearch([environmentId], query, { titlesOnly: true });
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const matches = threadLinkMatcher(query);
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        matches(`${thread.title} ${projectNames.get(thread.projectId) ?? ""}`),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Command mode="none" value={query} onValueChange={setQuery} aria-label={gt("Choose a thread")}>
      <CommandInput placeholder={gt("Search threads or projects...")} disabled={pending} />
      <CommandList className="max-h-80 overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            <T>No active threads found.</T>
          </div>
        ) : (
          candidates.map((thread) => {
            const linked = isLinked(thread);
            return (
              <CommandItem
                key={thread.id}
                value={thread.id}
                disabled={pending || linked}
                onClick={() => onSelect(thread.id)}
              >
                <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{thread.title || gt("Untitled thread")}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {projectNames.get(thread.projectId)}
                  </span>
                </span>
                {linked ? (
                  <>
                    <CheckIcon aria-hidden className="size-3.5" />
                    <span className="text-xs text-muted-foreground">
                      <T context="thread is linked">Linked</T>
                    </span>
                  </>
                ) : null}
              </CommandItem>
            );
          })
        )}
      </CommandList>
    </Command>
  );
}
