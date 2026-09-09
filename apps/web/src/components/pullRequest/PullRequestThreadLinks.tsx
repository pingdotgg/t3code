import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, PullRequestRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { CheckIcon, LinkIcon, MessageSquareIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";

import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { useProjects, useServerConfigs, useThreadShell, useThreadShells } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { openCommandPalette } from "~/commandPaletteBus";
import { Button } from "../ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { MenuItem } from "../ui/menu";
import { toastManager } from "../ui/toast";

interface PullRequestThreadLinksProps {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  url: string;
  threadRef: ScopedThreadRef | null;
  display: "count" | "menu-item" | "picker";
  onPickerOpenChange?: (open: boolean) => void;
}

/** Thread relations belong to the detail environment, including when another environment is active. */
export function PullRequestThreadLinks(props: PullRequestThreadLinksProps) {
  const configs = useServerConfigs();
  if (
    threadPullRequestLinkMode(configs.get(props.environmentId)?.environment.capabilities) ===
    "unsupported"
  ) {
    return null;
  }
  return <EnabledPullRequestThreadLinks key={`${props.environmentId}:${props.url}`} {...props} />;
}

function EnabledPullRequestThreadLinks({
  environmentId,
  reference,
  url,
  threadRef,
  display,
  onPickerOpenChange,
}: PullRequestThreadLinksProps) {
  const parsed = parseChangeRequestUrl(url);
  const currentThreadRef = threadRef?.environmentId === environmentId ? threadRef : null;
  const thread = useThreadShell(currentThreadRef);
  const linking = usePullRequestLinking(environmentId);
  const linkedHere = linking.isLinked(thread, url);
  const relations = useEnvironmentQuery(
    linking.mode === "multiple" && display !== "menu-item"
      ? pullRequestEnvironment.linkedThreads({
          environmentId,
          input: parsed === null ? reference : { ...reference, ...parsed },
        })
      : null,
  );
  // Refreshes can briefly clear the query value. Keep the last response so polling
  // does not hide the linked-thread count between responses.
  const [lastRelations, setLastRelations] = useState(relations.data);
  if (relations.data !== null && relations.data !== lastRelations) {
    setLastRelations(relations.data);
  }
  const [pending, setPending] = useState(false);

  const changeLink = async (threadId: ThreadId, remove: boolean) => {
    if (parsed === null || pending) return;
    setPending(true);
    try {
      await linking.changeLink(scopeThreadRef(environmentId, threadId), url, !remove);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: remove ? "Could not unlink the pull request" : "Could not link the pull request",
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      setPending(false);
    }
    if (linking.mode === "multiple") {
      appAtomRegistry.refresh(
        pullRequestEnvironment.linkedThreads({ environmentId, input: { ...reference, ...parsed } }),
      );
    }
    onPickerOpenChange?.(false);
  };

  if (parsed === null || (!linkedHere && !linking.canLink(url))) return null;
  const linkedThreads =
    linking.mode === "multiple" ? ((relations.data ?? lastRelations)?.threads ?? []) : [];
  const linkedThreadsLabel =
    linkedThreads.length > 0
      ? `Linked from ${linkedThreads.length} ${linkedThreads.length === 1 ? "thread" : "threads"}`
      : "Linked threads";
  return (
    <>
      {display === "count" && (linkedThreads.length > 0 || relations.error !== null) ? (
        <Button
          size="xs"
          variant="ghost"
          aria-label={linkedThreadsLabel}
          title={linkedThreadsLabel}
          onClick={() => openCommandPalette({ query: url })}
        >
          <MessageSquareIcon aria-hidden className="size-3.5" />
          <span aria-hidden>{linkedThreads.length || "?"}</span>
        </Button>
      ) : null}
      {display === "menu-item" ? (
        <MenuItem
          disabled={pending}
          onClick={() => {
            if (currentThreadRef !== null) {
              void changeLink(currentThreadRef.threadId, linkedHere);
            } else {
              onPickerOpenChange?.(true);
            }
          }}
        >
          {linkedHere ? (
            <UnlinkIcon aria-hidden className="size-3.5" />
          ) : (
            <LinkIcon aria-hidden className="size-3.5" />
          )}
          {linkedHere
            ? "Unlink from this thread"
            : currentThreadRef
              ? "Link to this thread"
              : "Link to thread"}
        </MenuItem>
      ) : null}
      {display === "picker" ? (
        <Dialog open onOpenChange={onPickerOpenChange}>
          <DialogPopup className="max-w-md" showCloseButton={false}>
            <DialogTitle className="sr-only">Link pull request to a thread</DialogTitle>
            <ThreadPicker
              environmentId={environmentId}
              url={url}
              pending={pending}
              onSelect={(threadId) => void changeLink(threadId, false)}
            />
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}

function ThreadPicker({
  environmentId,
  url,
  pending,
  onSelect,
}: {
  environmentId: EnvironmentId;
  url: string;
  pending: boolean;
  onSelect: (threadId: ThreadId) => void;
}) {
  const threads = useThreadShells();
  const linking = usePullRequestLinking(environmentId);
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const search = query.trim().toLocaleLowerCase();
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        `${thread.title} ${projectNames.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(search),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose a thread">
      <CommandInput placeholder="Search threads or projects..." disabled={pending} />
      <CommandList className="max-h-80 overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No active threads found.
          </div>
        ) : (
          candidates.map((thread) => {
            const linked = linking.isLinked(thread, url);
            return (
              <CommandItem
                key={thread.id}
                value={thread.id}
                disabled={pending || linked}
                onClick={() => onSelect(thread.id)}
              >
                <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{thread.title || "Untitled thread"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {projectNames.get(thread.projectId)}
                  </span>
                </span>
                {linked ? (
                  <>
                    <CheckIcon aria-hidden className="size-3.5" />
                    <span className="text-xs text-muted-foreground">Linked</span>
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
