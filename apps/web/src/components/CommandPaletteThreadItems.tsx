import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { findForMessageMatch, openThreadFindOnQuery } from "./chat/threadFindStore";
import {
  claimThreadOpen,
  nextShownOrder,
  threadSearchSubject,
  type EnvironmentThreadSearchMatch,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import {
  foldSearchQuery,
  PALETTE_MESSAGE_LIMIT,
  pickedQuery,
  rankMessageMatches,
  threadRecentUse,
} from "@t3tools/shared/paletteSearch";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { createContext, use, useState } from "react";
import { useGT, useMessages } from "gt-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { useLayoutStore } from "../layout/layoutStore";
import { followLayoutCompanions } from "../layout/openRules";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useDelegatedUnderParent, useVisibleThreadShells } from "../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useThreadSearch } from "../state/queries";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useStableCallback } from "../hooks/useStableCallback";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import {
  buildThreadActionItems,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";
import { useEnvironmentLookups, useProjectLookups } from "./CommandPaletteLookups";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";

function useProviderEntryByEnvironmentAndInstanceId() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const serverConfig = environment.serverConfig;
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
}

/**
 * The query thread rows match a pull request number against. A context, so typing re-renders
 * only the number, not every thread row.
 */
export const CommandPaletteThreadQueryContext = createContext("");

function PaletteThreadPullRequestNumber({ thread }: { thread: SidebarThreadSummary }) {
  return (
    <ThreadSearchPullRequestNumber
      thread={thread}
      query={use(CommandPaletteThreadQueryContext)}
      settled={thread.settledOverride === "settled"}
    />
  );
}

function useConnectedThreadSearch(query: string) {
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const environmentIds: ReadonlyArray<EnvironmentId> = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  // The palette matches environment names when there are several; older rows must match the same.
  const environmentLabels =
    environments.length > 1
      ? Object.fromEntries(
          environmentIds.flatMap((environmentId) => {
            const label = projectEnvironmentLocationById.get(environmentId)?.label;
            return label === undefined || label === null ? [] : [[environmentId, label]];
          }),
        )
      : undefined;
  return useThreadSearch(
    environmentIds,
    query,
    environmentLabels === undefined ? {} : { environmentLabels },
  );
}

type PaletteActiveThread = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

function useRecentThreads(
  activeThread: PaletteActiveThread | null,
  delegatedUnderParent: ReadonlySet<string>,
) {
  const threads = useVisibleThreadShells();
  const { projectByKey } = useProjectLookups();
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        !isShownUnderParent(
          { environmentId: thread.environmentId, threadId: thread.id },
          thread.lineage,
          delegatedUnderParent,
        ) &&
        !(thread.id === activeThread?.id && thread.environmentId === activeThread.environmentId),
    )
    .map((thread) => ({
      thread,
      usedAt: threadRecentUse(
        threadSearchSubject(
          thread,
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.title,
        ),
      ),
    }))
    .toSorted((left, right) => right.usedAt - left.usedAt)
    .slice(0, RECENT_THREAD_LIMIT)
    .map(({ thread }) => thread);
}

/**
 * Every visible thread as a palette item. Its own hook, so the rows are cached on the
 * threads alone and keep their identity while the query changes.
 */
function useThreadActionItems(input: {
  readonly activeThread: PaletteActiveThread | null;
  readonly includeAllThreads: boolean;
  readonly runThread: (thread: SidebarThreadSummary) => Promise<void>;
}) {
  const { activeThread, includeAllThreads, runThread } = input;
  const messages = useMessages();
  const gt = useGT();
  const threads = useVisibleThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const recentThreads = useRecentThreads(activeThread, delegatedUnderParent);
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const providerEntryByEnvironmentAndInstanceId = useProviderEntryByEnvironmentAndInstanceId();
  const { projectByKey } = useProjectLookups();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const threadItems = buildThreadActionItems(
    {
      threads: includeAllThreads ? threads : recentThreads,
      delegatedUnderParent,
      ...(environments.length > 1
        ? {
            environmentLabelOf: (thread: (typeof threads)[number]) =>
              projectEnvironmentLocationById.get(thread.environmentId)?.label ?? null,
          }
        : {}),
      ...(activeThread ? { activeThread } : {}),
      projectByKey,
      nowMs,
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
      renderTrailingContent: (thread) => (
        <>
          <PaletteThreadPullRequestNumber thread={thread} />
          <ThreadRowTrailingStatus thread={thread} />
        </>
      ),
      renderDescription: (thread, { projectTitle }) => {
        const modelInstanceId =
          thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
        const providerEntry =
          providerEntryByEnvironmentAndInstanceId.get(
            `${thread.environmentId}:${modelInstanceId}`,
          ) ?? null;
        return (
          <ThreadCommandSubtitle
            project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
            projectTitle={projectTitle ?? null}
            environmentLabel={
              projectEnvironmentLocationById.get(thread.environmentId)?.label ??
              gt("Remote", { $context: "machine location" })
            }
            branch={thread.branch}
            worktreePath={thread.worktreePath}
            isCurrent={
              thread.id === activeThread?.id && thread.environmentId === activeThread.environmentId
            }
            driverKind={providerEntry?.driverKind ?? null}
            providerDisplayName={
              thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
            }
            acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
            acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
          />
        );
      },
      runThread,
    },
    messages,
  );
  const itemByValue = new Map(threadItems.map((item) => [item.value, item]));
  // Recent threads stay on one line: provider logo, title, then the dim branch.
  const recentThreadItems = recentThreads.flatMap((thread): CommandPaletteActionItem[] => {
    const original = itemByValue.get(`thread:${thread.environmentId}:${thread.id}`);
    if (!original) return [];
    const { description: _description, ...item } = original;
    const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const providerEntry =
      providerEntryByEnvironmentAndInstanceId.get(`${thread.environmentId}:${modelInstanceId}`) ??
      null;
    return [
      {
        ...item,
        icon: providerEntry ? (
          <ProviderInstanceIcon
            driverKind={providerEntry.driverKind}
            displayName={thread.runtime?.providerName ?? providerEntry.displayName}
            acpRegistryAgentId={providerEntry.acpRegistryAgentId}
            acpRegistryIconUrl={providerEntry.acpRegistryIconUrl}
            iconClassName="size-3.5 shrink-0"
          />
        ) : (
          item.icon
        ),
        title: (
          <>
            {thread.title}
            {thread.branch ? (
              <span className="command-palette-recent-branch ms-2 text-caption text-dim-foreground">
                {thread.branch}
              </span>
            ) : null}
          </>
        ),
      },
    ];
  });
  return { threadItems, recentThreadItems, nowMs };
}

/**
 * Every visible thread as a palette item, plus, for a non-empty
 * `threadSearchQuery`, the threads whose messages match, best first.
 */
export function useCommandPaletteThreadItems(input: {
  readonly activeThread: PaletteActiveThread | null;
  readonly threadSearchQuery: string;
  readonly includeAllThreads: boolean;
}) {
  const { activeThread, threadSearchQuery, includeAllThreads } = input;
  const messages = useMessages();
  const navigate = useNavigate();
  const messageSearch = useConnectedThreadSearch(threadSearchQuery);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // Ranking is relative to when the palette opened, so rows do not reorder as time passes.
  const [now] = useState(() => Date.now());
  // Rows already shown keep their places when a slower environment answers.
  const [shownOrder, setShownOrder] = useState<ShownOrder | null>(null);
  // Reads the query when picked, so the rows need not be rebuilt on every keystroke.
  const runThread = useStableCallback(async (thread: SidebarThreadSummary) => {
    // A pick sends its open with the query, always, so the server records
    // it; the thread view then skips its own open. The open thread is no pick.
    const isOpen =
      activeThread?.environmentId === thread.environmentId && activeThread.id === thread.id;
    if (threadSearchQuery.trim().length > 0 && !threadSearchQuery.startsWith(">") && !isOpen) {
      claimThreadOpen(thread.environmentId, thread.id, Date.now());
    }
    if (
      threadSearchQuery.trim().length > 0 &&
      !threadSearchQuery.startsWith(">") &&
      thread.lastVisitedAt !== undefined &&
      !isOpen
    ) {
      void visitThread({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          visitedAt: thread.updatedAt,
          opened: true,
          searchQuery: pickedQuery(threadSearchQuery),
        },
      });
    }
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    // A tab already open in the layout takes focus even if its URL is current.
    followLayoutCompanions(() =>
      useLayoutStore.getState().focusChat({ kind: "server", threadRef }),
    );
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  });
  const { threadItems, recentThreadItems, nowMs } = useThreadActionItems({
    activeThread,
    includeAllThreads,
    runThread,
  });

  const itemByValue = new Map(threadItems.map((item) => [item.value, item]));
  const itemForMatch = (match: EnvironmentThreadSearchMatch) =>
    itemByValue.get(`thread:${match.environmentId}:${match.threadId}`);
  const rankedMessageItems = rankMessageMatches(
    messageSearch.matches,
    (match) => itemForMatch(match)?.threadSearch,
    foldSearchQuery(threadSearchQuery),
    now,
    { withoutTitleMatches: true },
  ).flatMap((match) => {
    const item = itemForMatch(match);
    if (!item) return [];
    // The snippet replaces the project line, so a message row is as tall as a title row.
    const { description: _description, ...rest } = item;
    return [
      {
        ...rest,
        // When the matching message was written, not when the thread last moved.
        ...(match.messageCreatedAt
          ? { timestamp: formatRelativeTimeLabel(match.messageCreatedAt, nowMs, messages) }
          : {}),
        threadContentMatch: {
          source: match.source,
          snippet: match.snippet,
          query: messageSearch.query,
        },
        // Opens the thread with find on the word at the matched message, so it is in view.
        run: async () => {
          await item.run();
          openThreadFindOnQuery(
            scopedThreadKey(scopeThreadRef(match.environmentId, match.threadId)),
            findForMessageMatch(match, messageSearch.query),
          );
        },
      },
    ];
  });

  const order = nextShownOrder(
    shownOrder,
    messageSearch.query,
    rankedMessageItems.map((item) => item.value),
    PALETTE_MESSAGE_LIMIT,
  );
  if (order !== shownOrder) setShownOrder(order);
  const messageItemByValue = new Map(rankedMessageItems.map((item) => [item.value, item]));
  const threadMessageItems = order.keys
    .slice(0, order.shown)
    .flatMap((value) => messageItemByValue.get(value) ?? []);

  return {
    threadItems,
    recentThreadItems,
    threadMessageItems,
    now,
    isSearchPending: messageSearch.isPending,
    isSearchFailed: messageSearch.failed,
  };
}
