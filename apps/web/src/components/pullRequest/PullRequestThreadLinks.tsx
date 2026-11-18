import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { visibleLinkedThreads } from "@t3tools/client-runtime/state/threads";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import { Branch, msg, T, useGT } from "gt-react";
import { useState } from "react";
import { searchItems, SEARCH_SECONDARY_FIELD_WEIGHT } from "@t3tools/shared/searchRanking";

import { m } from "~/i18n/messages";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { normalizeThreadPullRequestKey } from "@t3tools/client-runtime/thread-pull-requests";
import {
  useAnyEnvironmentHiding,
  useEnvironmentThreadRefs,
  useProjects,
  useServerConfigs,
  useThreadShell,
  useVisibleThreadShells,
} from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { environmentThreadShells } from "~/state/threads";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadSearch } from "~/state/queries";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { openCommandPalette } from "~/commandPaletteBus";
import { Button } from "../ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { MenuItem } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { PullRequestGlyph } from "./pullRequestIcons";

import { changeRequestTermKind } from "./changeRequestTerm";

interface PullRequestThreadLinksProps {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  url: string;
  threadRef: ScopedThreadRef | null;
  display: "count" | "menu-item" | "picker";
  onPickerOpenChange?: (open: boolean) => void;
}

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
  const parsedUrl = sourceControlClients.parseChangeRequestUrl(url);
  const parsed = parsedUrl?.link ?? null;
  const term = changeRequestTermKind(
    (parsedUrl?.definition ?? sourceControlClients.get(undefined)).changeRequest,
  );
  const thread = useThreadShell(threadRef?.environmentId === environmentId ? threadRef : null);
  const currentThreadRef = thread === null ? null : threadRef;
  const linking = usePullRequestLinking(environmentId);
  const linkedHere = linking.isLinked(thread, url);
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const hidingAnywhere = useAnyEnvironmentHiding();
  const loadedThreadRefs = useEnvironmentThreadRefs(environmentId);
  const relations = useEnvironmentQuery(
    linking.mode === "multiple" && display !== "menu-item"
      ? pullRequestEnvironment.linkedThreads({
          environmentId,
          input:
            parsed === null
              ? reference
              : { ...reference, ...normalizeThreadPullRequestKey(parsed) },
        })
      : null,
  );
  // Retain the last count while refresh temporarily clears query data.
  const gt = useGT();
  const [lastRelations, setLastRelations] = useState(relations.data);
  if (relations.data !== null && relations.data !== lastRelations) {
    setLastRelations(relations.data);
  }
  const [pending, setPending] = useState(false);

  const changeLink = async (threadId: ThreadId, remove: boolean) => {
    if (parsed === null || pending) return;
    setPending(true);
    const result = await settlePromise(() =>
      linking.changeLink(scopeThreadRef(environmentId, threadId), url, !remove),
    );
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: remove
          ? m(
              msg(
                "Could not unlink the {term, select, mr {merge request} cr {change request} other {pull request}}",
                { term },
              ),
            )
          : m(
              msg(
                "Could not link the {term, select, mr {merge request} cr {change request} other {pull request}}",
                { term },
              ),
            ),
        description: thrownErrorMessage(error, m) ?? String(error),
      });
      return;
    }
    if (linking.mode === "multiple") {
      appAtomRegistry.refresh(
        pullRequestEnvironment.linkedThreads({
          environmentId,
          input: { ...reference, ...normalizeThreadPullRequestKey(parsed) },
        }),
      );
    }
    onPickerOpenChange?.(false);
  };

  if (parsed === null || (!linkedHere && !linking.canLink(url))) return null;
  const linkedThreads = visibleLinkedThreads(
    linking.mode === "multiple" ? ((relations.data ?? lastRelations)?.threads ?? []) : [],
    environmentId,
    loadedThreadRefs,
    hiddenKeys,
    hidingAnywhere,
  );
  const linkedThreadsLabel =
    linkedThreads.length > 0
      ? gt(
          "{count, plural, one {Linked from {count} thread} other {Linked from {count} threads}}",
          {
            count: linkedThreads.length,
          },
        )
      : gt("Linked threads");
  return (
    <>
      {display === "count" && (linkedThreads.length > 0 || relations.error !== null) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                aria-label={linkedThreadsLabel}
                onClick={() =>
                  openCommandPalette({
                    query: url,
                    ...((relations.data ?? lastRelations) === null
                      ? {}
                      : { linkedThreads: { environmentId, threads: linkedThreads } }),
                  })
                }
              >
                <MessageSquareIcon aria-hidden className="size-3.5" />
                <span aria-hidden>{linkedThreads.length || "?"}</span>
              </Button>
            }
          />
          <TooltipPopup>
            {gt("{label}. Search in the command palette.", { label: linkedThreadsLabel })}
          </TooltipPopup>
        </Tooltip>
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
            <PullRequestGlyph.unlink aria-hidden className="size-3.5" />
          ) : (
            <PullRequestGlyph.link aria-hidden className="size-3.5" />
          )}
          {linkedHere
            ? gt("Unlink from this thread")
            : currentThreadRef
              ? gt("Link to this thread")
              : gt("Link to thread")}
        </MenuItem>
      ) : null}
      {display === "picker" ? (
        <Dialog open onOpenChange={onPickerOpenChange}>
          <DialogPopup className="max-w-md" showCloseButton={false}>
            <DialogTitle className="sr-only">
              <T>
                Link{" "}
                <Branch branch={term} mr="merge request" cr="change request">
                  pull request
                </Branch>{" "}
                to a thread
              </T>
            </DialogTitle>
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
  const gt = useGT();
  const threads = useVisibleThreadShells();
  const linking = usePullRequestLinking(environmentId);
  const projects = useProjects();
  const [query, setQuery] = useState("");
  // Mounts older settled threads matching the query, which shells may leave out.
  useThreadSearch([environmentId], query, { titlesOnly: true });
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const eligibleThreads = threads
    .filter((thread) => thread.environmentId === environmentId && thread.archivedAt === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const candidates = searchItems(eligibleThreads, query, (thread) => [
    thread.title,
    { value: projectNames.get(thread.projectId) ?? "", weight: SEARCH_SECONDARY_FIELD_WEIGHT },
  ]);
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
