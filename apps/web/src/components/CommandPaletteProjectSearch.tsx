import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type ProjectCodeError,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BrainIcon, BracesIcon, MessageSquareIcon, NetworkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { msg, T, useMessages } from "gt-react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import type { MessageResolver } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectCode } from "~/state/projectCode";
import { projectKnowledge } from "~/state/projectKnowledge";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";
import { buildThreadRouteParams } from "~/threadRoutes";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { findForMessageMatch, openThreadFindOnQuery } from "./chat/threadFindStore";
import { useOpenCodeExplorer } from "./codeExplorer/openCodeExplorer";
import { useOpenProjectMemory } from "./projectKnowledge/ProjectMemoryPanel";

const SEARCH_DEBOUNCE_MS = 250;
const GROUP_LIMIT = 8;
// The explorer is a second action on the best symbol matches, not a second result list.
const EXPLORE_LIMIT = 3;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;

export interface ProjectSearchTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** Where a symbol's file preview opens; a draft has no server thread yet. */
  readonly threadRef: ScopedThreadRef;
  readonly serverThreadId: ThreadId | null;
}

type GroupState =
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "pending" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly items: ReadonlyArray<CommandPaletteActionItem> };

function useProjectSearchTarget(): ProjectSearchTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  if (!thread || !threadId || !project) return null;
  return {
    environmentId: project.environmentId,
    projectId: project.id,
    projectName: project.title,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
    serverThreadId: activeThread?.id ?? null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryTerms(query: string): ReadonlyArray<string> {
  // Longest first so a term that contains another wins the alternation.
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].toSorted(
    (left, right) => right.length - left.length,
  );
}

function HighlightedTerms(props: { readonly text: string; readonly terms: ReadonlyArray<string> }) {
  if (props.terms.length === 0) return props.text;
  const parts = props.text.split(new RegExp(`(${props.terms.map(escapeRegExp).join("|")})`, "gi"));
  // `split` with one capture group puts the matched terms at odd indices.
  let offset = 0;
  return parts.map((part, index) => {
    const start = offset;
    offset += part.length;
    return index % 2 === 1 ? (
      <mark className="bg-transparent font-semibold text-foreground" key={start}>
        {part}
      </mark>
    ) : (
      part
    );
  });
}

function Snippet(props: { readonly children: ReactNode }) {
  return <span className="block truncate">{props.children}</span>;
}

const FACT_KIND_LABEL = {
  decision: msg("Decision"),
  constraint: msg("Constraint"),
  convention: msg("Convention"),
  note: msg("Note"),
} as const;

function useFactGroup(target: ProjectSearchTarget, query: string | null): GroupState {
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const available = config?.environment.capabilities.projectKnowledge === true;
  const openProjectMemory = useOpenProjectMemory();
  // A search request id names one ranking, so it changes with the query and not per render.
  const [request, setRequest] = useState<{ query: string; requestId: CommandId } | null>(null);
  if (available && query !== null && request?.query !== query) {
    setRequest({ query, requestId: CommandId.make(randomUUID()) });
  }
  const active = available && query !== null && request?.query === query ? request : null;
  const search = useEnvironmentQuery(
    active
      ? projectKnowledge.search({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            query: active.query,
            requestId: active.requestId,
            limit: GROUP_LIMIT,
            // As-you-type results are browsing, not recall; they must not reinforce ranking.
            recordRetrieval: false,
          },
        })
      : null,
    m,
  );
  if (!available) {
    return {
      status: "unavailable",
      message: m(msg("Project memory is not available on this server.")),
    };
  }
  if (search.error) return { status: "error", message: search.error };
  if (!search.data || search.isPending) return { status: "pending" };
  if (search.data.facts.state === "unavailable") {
    return {
      status: "unavailable",
      message: m(msg("Fact ranking is unavailable on this server.")),
    };
  }
  const terms = queryTerms(active?.query ?? "");
  return {
    status: "ready",
    items: search.data.facts.matches.slice(0, GROUP_LIMIT).flatMap(({ fact }) =>
      fact.content === null
        ? []
        : [
            {
              kind: "action" as const,
              value: `fact:${fact.id}`,
              searchTerms: [],
              title: <HighlightedTerms text={fact.content} terms={terms} />,
              description: m(msg("{kind} · {status} · trust {trust}"), {
                kind: m(FACT_KIND_LABEL[fact.kind]),
                status: fact.status,
                trust: fact.trust.toFixed(2),
              }),
              icon: <BrainIcon className={ITEM_ICON_CLASS} />,
              run: async () => {
                openProjectMemory({
                  environmentId: target.environmentId,
                  projectId: target.projectId,
                  fact: { id: fact.id, query: active?.query ?? fact.content },
                });
              },
            },
          ],
    ),
  };
}

function useConversationGroup(target: ProjectSearchTarget, query: string | null): GroupState {
  const m = useMessages();
  const navigate = useNavigate();
  const threads = useThreadShells();
  const config = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const search = useEnvironmentQuery(
    query === null
      ? null
      : orchestrationEnvironment.threadSearch({
          environmentId: target.environmentId,
          input: { query, projectId: target.projectId, limit: GROUP_LIMIT },
        }),
    m,
  );
  if (search.error) return { status: "error", message: search.error };
  if (!search.data || search.isPending) return { status: "pending" };
  const titleById = new Map(
    threads
      .filter((thread) => thread.environmentId === target.environmentId)
      .map((thread) => [thread.id, thread.title] as const),
  );
  const terms = queryTerms(query ?? "");
  return {
    status: "ready",
    items: search.data.matches.slice(0, GROUP_LIMIT).map((match, index) => ({
      kind: "action" as const,
      value: `conversation:${match.threadId}:${match.messageId ?? index}`,
      searchTerms: [],
      title: titleById.get(match.threadId) || m(msg("Untitled thread")),
      description: (
        <Snippet>
          <span
            className={match.source === "user" ? "text-info-foreground" : "text-success-foreground"}
          >
            {match.source === "user" ? m(msg("You:")) : m(msg("Agent:"))}
          </span>{" "}
          <HighlightedTerms text={match.snippet} terms={terms} />
        </Snippet>
      ),
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const threadRef = scopeThreadRef(target.environmentId, match.threadId);
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        // Find belongs to the shown thread, so it opens once the route shows this one.
        if (config?.threadFind === true && query !== null) {
          openThreadFindOnQuery(scopedThreadKey(threadRef), findForMessageMatch(match, query));
        }
      },
    })),
  };
}

// Project code errors are tagged data, not Errors, so the generic message would say nothing.
const PROJECT_CODE_ERROR_MESSAGE: Partial<Record<ProjectCodeError["_tag"], string>> = {
  "project-not-found": msg("This project is no longer available."),
  "thread-project-mismatch": msg("This thread belongs to another project."),
  "authority-failed": msg("The code index could not read this workspace."),
  "path-outside-checkout": msg("A symbol path is outside this checkout."),
  "analysis-failed": msg("Code analysis failed for this workspace."),
};

function projectCodeErrorMessage(failure: unknown, resolve: MessageResolver): string | undefined {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) return undefined;
  const message = PROJECT_CODE_ERROR_MESSAGE[failure._tag as ProjectCodeError["_tag"]];
  return message === undefined ? undefined : resolve(message);
}

interface SymbolGroups {
  readonly symbols: GroupState;
  readonly explore: ReadonlyArray<CommandPaletteActionItem>;
}

function useSymbolGroups(target: ProjectSearchTarget, query: string | null): SymbolGroups {
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const canQuery = useAtomValue(projectCode.query.permissionAtom(target.environmentId));
  const openExplorer = useOpenCodeExplorer();
  const available = config?.environment.capabilities.projectCode === true;
  const search = useEnvironmentQuery(
    available && canQuery && query !== null
      ? projectCode.query({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            ...(target.serverThreadId ? { threadId: target.serverThreadId } : {}),
            query: { operation: "search", text: query, limit: GROUP_LIMIT },
          },
        })
      : null,
    m,
  );
  const only = (symbols: GroupState): SymbolGroups => ({ symbols, explore: [] });
  if (!available) {
    return only({
      status: "unavailable",
      message: m(msg("Code search is not available on this server.")),
    });
  }
  if (!canQuery) {
    return only({
      status: "unavailable",
      message: m(msg("This connection cannot read project files.")),
    });
  }
  if (search.error) {
    return only({
      status: "error",
      message: projectCodeErrorMessage(search.failure, m) ?? search.error,
    });
  }
  if (!search.data || search.isPending) return only({ status: "pending" });
  if (search.data.coverage.state === "unavailable") {
    return only({
      status: "unavailable",
      message: m(msg("The code index is not ready for this project.")),
    });
  }
  const terms = queryTerms(query ?? "");
  const matches = search.data.matches;
  return {
    symbols: {
      status: "ready",
      items: matches.slice(0, GROUP_LIMIT).map(({ symbol }) => ({
        kind: "action" as const,
        value: `symbol:${symbol.id}`,
        searchTerms: [],
        title: <HighlightedTerms text={symbol.name} terms={terms} />,
        description: (
          <Snippet>
            {symbol.kind} · {symbol.path}:{symbol.startLine}
          </Snippet>
        ),
        icon: <BracesIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          useRightPanelStore.getState().openFile(target.threadRef, symbol.path, symbol.startLine);
        },
      })),
    },
    explore: matches.slice(0, EXPLORE_LIMIT).map(({ symbol }) => ({
      kind: "action" as const,
      value: `explore:${symbol.id}`,
      searchTerms: [],
      title: m(msg("Explore {name}"), { name: symbol.name }),
      description: (
        <Snippet>{m(msg("Callers and callees · {path}"), { path: symbol.path })}</Snippet>
      ),
      icon: <NetworkIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openExplorer({
          environmentId: target.environmentId,
          projectId: target.projectId,
          threadRef: target.threadRef,
          serverThreadId: target.serverThreadId,
          symbol,
        });
      },
    })),
  };
}

const EMPTY_MESSAGE = {
  facts: msg("No matching facts."),
  conversations: msg("No matching messages."),
  symbols: msg("No matching symbols."),
} as const;

function toGroup(
  value: keyof typeof EMPTY_MESSAGE,
  label: string,
  icon: ReactNode,
  state: GroupState,
  resolve: MessageResolver,
): CommandPaletteGroup {
  if (state.status === "ready" && state.items.length > 0) {
    return { value, label, items: state.items };
  }
  // Status rows are disabled so keyboard navigation only lands on real results.
  const message =
    state.status === "ready"
      ? resolve(EMPTY_MESSAGE[value])
      : state.status === "pending"
        ? resolve(msg("Searching…"))
        : state.message;
  return {
    value,
    label,
    items: [
      {
        kind: "action",
        value: `${value}:status`,
        searchTerms: [],
        title: <span className="text-muted-foreground">{message}</span>,
        icon,
        disabled: true,
        run: async () => {},
      },
    ],
  };
}

export function OpenProjectSearchPalette(props: {
  readonly target: ProjectSearchTarget;
  readonly setOpen: (open: boolean) => void;
}) {
  const m = useMessages();
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const normalized = query.trim();
  const debounced = useDebouncedValue(normalized, SEARCH_DEBOUNCE_MS);
  const searchable = normalized.length >= MIN_QUERY_LENGTH && normalized.length <= MAX_QUERY_LENGTH;
  // Every group reads the same settled query; a newer keystroke drops all three back to pending.
  const settled = searchable && debounced === normalized ? normalized : null;
  const facts = useFactGroup(props.target, settled);
  const conversations = useConversationGroup(props.target, settled);
  const { symbols, explore } = useSymbolGroups(props.target, settled);
  const pending: GroupState = { status: "pending" };
  const groups = searchable
    ? [
        toGroup(
          "facts",
          m(msg("Facts")),
          <BrainIcon className={ITEM_ICON_CLASS} />,
          settled ? facts : pending,
          m,
        ),
        toGroup(
          "conversations",
          m(msg("Conversations")),
          <MessageSquareIcon className={ITEM_ICON_CLASS} />,
          settled ? conversations : pending,
          m,
        ),
        toGroup(
          "symbols",
          m(msg("Symbols")),
          <BracesIcon className={ITEM_ICON_CLASS} />,
          settled ? symbols : pending,
          m,
        ),
        ...(settled && explore.length > 0
          ? [{ value: "explore", label: m(msg("Code explorer")), items: explore }]
          : []),
      ]
    : [];

  return (
    <CommandPaletteContent
      aria-label={m(msg("Project search"))}
      autoHighlight="always"
      escapeLabel={m(msg("Back"))}
      footerActionLabel={m(msg("Open"))}
      inputProps={{
        placeholder: m(msg("Search {project} facts, conversations, and symbols…"), {
          project: props.target.projectName,
        }),
        maxLength: MAX_QUERY_LENGTH,
      }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="project-search"
      value={query}
    >
      <CommandPaletteResults
        emptyStateMessage={m(msg("Type at least two characters to search this project."))}
        groups={groups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action" || item.disabled) return;
          props.setOpen(false);
          void item.run();
        }}
      />
    </CommandPaletteContent>
  );
}

export function ProjectSearchPalette(props: { readonly setOpen: (open: boolean) => void }) {
  const m = useMessages();
  const target = useProjectSearchTarget();
  if (!target) {
    return (
      <CommandPaletteContent
        aria-label={m(msg("Project search"))}
        escapeLabel={m(msg("Back"))}
        inputProps={{ disabled: true, placeholder: m(msg("Search project…")) }}
        mode="none"
        testId="project-search"
        value=""
      >
        <div className="py-10 text-center text-sm text-muted-foreground">
          <T>Open a project to search its facts, conversations, and symbols.</T>
        </div>
      </CommandPaletteContent>
    );
  }
  return <OpenProjectSearchPalette setOpen={props.setOpen} target={target} />;
}
