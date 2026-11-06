import { cn, randomUUID } from "../../lib/utils";
import { useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CommandId,
  type EnvironmentId,
  type KnowledgeConflictHint,
  type KnowledgeFactSource,
  type KnowledgeMessageRef,
  type KnowledgeSelection,
  type MessageId,
  type ProjectFact,
  type ProjectFactId,
  type ProjectId,
  type ProjectKnowledgeMutation,
  type ProjectKnowledgePreparedContext,
  type ProjectKnowledgeSearchInput,
  type ThreadId,
} from "@t3tools/contracts";
import { projectKnowledgeContextRecord } from "@t3tools/client-runtime/projectKnowledge";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BrainIcon } from "lucide-react";
import { Button } from "../ui/button";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStableCallback } from "../../hooks/useStableCallback";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { projectKnowledge } from "../../state/projectKnowledge";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { ConflictHintRow, KnowledgeHealthStrip } from "./ProjectFactDetail";
import { AssistedLearningSection } from "./AssistedLearningSection";
import { ProjectFactEditor, type EditableFact, type FactEditorSeed } from "./ProjectFactEditor";
import { ProjectMemoryFactList } from "./ProjectMemoryFactList";
import {
  FactInspector,
  INSPECTOR_HEADING,
  InspectorEmpty,
  SourceInspector,
  type SourceRef,
} from "./ProjectMemoryInspector";
import { MAX_DRAFT_SELECTIONS, ProjectMemoryDraftFooter } from "./ProjectMemoryDraftFooter";
import { factRowKey, messageRowKey, selectionKey, shortFactId } from "./projectMemoryLabels";

type Scope = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  composerDraftTarget: ComposerThreadTarget;
};
type ProjectScope = Pick<Scope, "environmentId" | "projectId">;
type MessageCitation = { readonly threadId: ThreadId; readonly messageId: MessageId };

// The dialog is opened from the thread panel, timeline messages, the command
// palette and a keybinding, so its open state lives outside any one of them.
// A fact opened from search shows that search again, so the fact is in view.
type FactFocus = { readonly id: ProjectFactId; readonly query: string };
type OpenRequest = ProjectScope & {
  readonly message: MessageCitation | null;
  readonly fact: FactFocus | null;
  readonly key: number;
};
const openRequestAtom = Atom.make<OpenRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:project-memory"),
);
let nextRequestKey = 0;
// Module scope: the React Compiler cannot lower an update of a global inside a hook.
const takeRequestKey = () => ++nextRequestKey;

const FORGET_CONFIRM_DETAIL =
  "Its content, history and every copy sent to agents are removed and cannot be restored. If the fact changed rather than became wrong, supersede it instead.";

export function useProjectMemoryAvailable(environmentId: EnvironmentId | null): boolean {
  const config = useAtomValue(
    serverEnvironment.configValueAtom(environmentId ?? ("" as EnvironmentId)),
  );
  return environmentId !== null && config?.environment.capabilities.projectKnowledge === true;
}

// Older servers lack readFact, status and the supersede mutation.
function useProjectMemoryHistoryAvailable(environmentId: EnvironmentId): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.environment.capabilities.projectKnowledgeHistory === true;
}

function useProjectMemoryAssistedAvailable(environmentId: EnvironmentId): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.environment.capabilities.projectKnowledgeAssistedLearning === true;
}

export function useOpenProjectMemory() {
  const setRequest = useAtomSet(openRequestAtom);
  return (
    scope: ProjectScope & { readonly message?: MessageCitation; readonly fact?: FactFocus },
  ) =>
    setRequest({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      message: scope.message ?? null,
      fact: scope.fact ?? null,
      key: takeRequestKey(),
    });
}

export function ProjectMemoryPanel(props: ProjectScope) {
  const available = useProjectMemoryAvailable(props.environmentId);
  const open = useOpenProjectMemory();
  if (!available) return null;
  return (
    <ThreadDetailsControl onClick={() => open(props)}>
      <BrainIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className={`min-w-0 flex-1 truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
        Project memory
      </span>
    </ThreadDetailsControl>
  );
}

export function ProjectMemoryDialogHost(props: Scope) {
  const available = useProjectMemoryAvailable(props.environmentId);
  const [request, setRequest] = useAtom(openRequestAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the shared open request this host holds until unmount
  useEffect(() => () => setRequest(null), [setRequest]);
  const active =
    available &&
    request !== null &&
    request.environmentId === props.environmentId &&
    request.projectId === props.projectId
      ? request
      : null;
  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
    >
      <DialogPopup className="h-[min(48rem,calc(100dvh-2rem))] max-w-5xl max-sm:h-[calc(100dvh-3rem)]">
        <DialogHeader>
          <DialogTitle>Project memory</DialogTitle>
          <DialogDescription>
            Browse saved project facts and their evidence, and choose what belongs in this draft.
          </DialogDescription>
        </DialogHeader>
        {active ? (
          <MemoryContents
            key={`${active.key}:${typeof props.composerDraftTarget === "string" ? props.composerDraftTarget : scopedThreadKey(props.composerDraftTarget)}`}
            {...props}
            seedMessage={active.message}
            focusFact={active.fact}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

type ListFilter = "saved" | "automatic" | "forgotten" | "lost";
const FILTER_LABEL: Record<Exclude<ListFilter, "lost">, string> = {
  saved: "Saved",
  automatic: "Automatic",
  forgotten: "Forgotten",
};

// What the inspector shows. Selecting for the draft is separate state: inspecting never selects.
type Inspection =
  | { readonly kind: "empty" }
  | { readonly kind: "fact"; readonly factId: ProjectFactId }
  | { readonly kind: "source"; readonly ref: SourceRef; readonly returnTo: ProjectFactId | null };

function MemoryContents(
  props: Scope & {
    readonly seedMessage: MessageCitation | null;
    readonly focusFact: FactFocus | null;
  },
) {
  const target = props.composerDraftTarget;
  const registry = useContext(RegistryContext);
  const draft = useComposerThreadDraft(target);
  const attached = draft.knowledgeContexts?.[0];
  const [selections, setSelections] = useState<ReadonlyArray<KnowledgeSelection>>(
    attached?.knowledge.selections ?? [],
  );
  const [query, setQuery] = useState(props.focusFact?.query ?? "");
  const [searchInput, setSearchInput] = useState<ProjectKnowledgeSearchInput | null>(() =>
    props.focusFact
      ? {
          projectId: props.projectId,
          query: props.focusFact.query,
          includeArchived: false,
          requestId: CommandId.make(randomUUID()),
        }
      : null,
  );
  const [filter, setFilter] = useState<ListFilter>("saved");
  const [afterId, setAfterId] = useState<ProjectFactId | undefined>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [inspection, setInspection] = useState<Inspection>(() =>
    props.focusFact
      ? { kind: "fact", factId: props.focusFact.id }
      : props.seedMessage
        ? { kind: "source", ref: props.seedMessage, returnTo: null }
        : { kind: "empty" },
  );
  const [editor, setEditor] = useState<{
    readonly key: string;
    readonly seed: FactEditorSeed;
  } | null>(null);
  // Below md the list and inspector stack; this picks which one is visible.
  const [showDetail, setShowDetail] = useState(inspection.kind !== "empty");
  const [healthOpen, setHealthOpen] = useState(false);
  const [hintNotice, setHintNotice] = useState<{
    readonly content: string | null;
    readonly hints: ReadonlyArray<KnowledgeConflictHint>;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionVersion = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates in-flight selection work when the dialog unmounts
  useEffect(
    () => () => {
      selectionVersion.current += 1;
    },
    [],
  );
  const [preview, setPreview] = useState<ProjectKnowledgePreparedContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const narrow = useMediaQuery("max-md");
  const canMutate = useAtomValue(projectKnowledge.mutate.permissionAtom(props.environmentId));
  const historyAvailable = useProjectMemoryHistoryAvailable(props.environmentId);
  const showSuperseded = historyAvailable && includeSuperseded;
  const assistedAvailable = useProjectMemoryAssistedAvailable(props.environmentId);
  const list = useEnvironmentQuery(
    projectKnowledge.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        ...(historyAvailable && filter === "lost"
          ? { sourceState: "unavailable" as const }
          : filter === "automatic"
            ? { status: "saved" as const, origin: "assisted" as const }
            : { status: filter === "lost" ? ("saved" as const) : filter }),
        ...(afterId ? { afterId } : {}),
        ...(showSuperseded ? { includeSuperseded: true } : {}),
      },
    }),
  );
  const health = useEnvironmentQuery(
    historyAvailable
      ? projectKnowledge.status({
          environmentId: props.environmentId,
          input: { projectId: props.projectId },
        })
      : null,
  );
  const search = useEnvironmentQuery(
    searchInput
      ? projectKnowledge.search({
          environmentId: props.environmentId,
          input: { ...searchInput, recordRetrieval: false },
        })
      : null,
  );
  const inspectedSource = inspection.kind === "source" ? inspection.ref : null;
  const sourceQuery = useEnvironmentQuery(
    inspectedSource
      ? projectKnowledge.readSource({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, ...inspectedSource, includeArchived },
        })
      : null,
  );
  const mutate = useAtomCommand(projectKnowledge.mutate, { reportFailure: false });
  const prepare = useAtomCommand(projectKnowledge.prepareContext, { reportFailure: false });

  const focusIn = (selector: string) =>
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  // Desktop keeps focus on the list row so arrow-key browsing continues; when the inspector
  // replaces the list (narrow) or a source opens, focus moves to the inspector heading.
  const inspect = (next: Inspection, moveFocus: boolean) => {
    flushSync(() => {
      setInspection(next);
      setEditor(null);
      setShowDetail(true);
    });
    if (moveFocus || narrow) focusIn(INSPECTOR_HEADING);
  };
  const inspectFact = (factId: ProjectFactId) => inspect({ kind: "fact", factId }, false);
  const openSource = (ref: SourceRef, returnTo: ProjectFactId | null) =>
    inspect({ kind: "source", ref, returnTo }, true);
  const inspectedRowKey =
    inspection.kind === "fact"
      ? factRowKey(inspection.factId)
      : inspection.kind === "source"
        ? messageRowKey(inspection.ref)
        : null;
  const backToList = () => {
    flushSync(() => setShowDetail(false));
    const row = inspectedRowKey
      ? rootRef.current?.querySelector<HTMLElement>(
          `[data-memory-row="${CSS.escape(inspectedRowKey)}"]`,
        )
      : null;
    if (row) row.focus();
    else focusIn("[data-memory-search]");
  };
  const openEditor = (seed: FactEditorSeed) => {
    setEditor({ key: randomUUID(), seed });
    setShowDetail(true);
  };
  const cancelEditor = () => {
    flushSync(() => setEditor(null));
    if (inspection.kind === "fact") focusIn("[data-inspector-edit]");
    else if (inspection.kind === "empty") setShowDetail(false);
    else focusIn(INSPECTOR_HEADING);
  };

  const invalidateAttachment = () => {
    selectionVersion.current += 1;
    setPreview(null);
    useComposerDraftStore.getState().setKnowledgeContext(target, null);
  };
  const toggle = (selection: KnowledgeSelection) => {
    invalidateAttachment();
    setSelections((current) =>
      current.some((item) => selectionKey(item) === selectionKey(selection))
        ? current.filter((item) => selectionKey(item) !== selectionKey(selection))
        : [...current, selection].slice(0, MAX_DRAFT_SELECTIONS),
    );
  };
  const restartSearch = (superseded = showSuperseded) =>
    setSearchInput((current) =>
      current === null
        ? null
        : {
            projectId: current.projectId,
            query: current.query,
            includeArchived: current.includeArchived ?? false,
            ...(superseded ? { includeSuperseded: true } : {}),
            requestId: CommandId.make(randomUUID()),
          },
    );
  const refreshFact = (factId: ProjectFactId) => {
    if (historyAvailable)
      registry.refresh(
        projectKnowledge.readFact({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, factId },
        }),
      );
  };
  const refresh = (changedFactIds: ReadonlyArray<ProjectFactId> = []) => {
    list.refresh();
    health.refresh();
    restartSearch();
    for (const factId of new Set([
      ...changedFactIds,
      ...(inspection.kind === "fact" ? [inspection.factId] : []),
    ]))
      refreshFact(factId);
  };
  const finishEditor = useStableCallback((savedEditor: typeof editor, factId: ProjectFactId) => {
    // A delayed save must not close or steal focus from an editor opened in the meantime.
    if (savedEditor === null || editor !== savedEditor) return;
    flushSync(() => {
      setEditor(null);
      setInspection({ kind: "fact", factId });
    });
    focusIn(INSPECTOR_HEADING);
  });
  const apply = async (input: ProjectKnowledgeMutation, savedEditor: typeof editor = null) => {
    setBusy(true);
    setError(null);
    setHintNotice(null);
    invalidateAttachment();
    const result = await mutate({ environmentId: props.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      // A superseded fact drops out of recall, so its selection goes with the revised one.
      const replaced = new Set<ProjectFactId>([result.value.id, input.factId]);
      setSelections((current) =>
        current.filter((item) => item.kind !== "fact" || !replaced.has(item.factId)),
      );
      if (result.value.hints?.length)
        setHintNotice({ content: result.value.content, hints: result.value.hints });
      finishEditor(savedEditor, result.value.id);
    }
    refresh([input.factId, ...(result._tag === "Success" ? [result.value.id] : [])]);
  };
  const revise = async (fact: ProjectFact, action: "forget" | "feedback", helpful = true) => {
    if (action === "forget") {
      const message = `Forget this fact permanently?\n${FORGET_CONFIRM_DETAIL}`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    const fields = {
      commandId: CommandId.make(randomUUID()),
      projectId: props.projectId,
      factId: fact.id,
      expectedRevision: fact.revision,
    };
    void apply(action === "feedback" ? { ...fields, action, helpful } : { ...fields, action });
  };
  const attach = async () => {
    const version = ++selectionVersion.current;
    setBusy(true);
    setError(null);
    setPreview(null);
    const context = {
      environmentId: props.environmentId,
      projectId: props.projectId,
      selections,
      includeArchived,
      maxBytes: 48000,
    };
    const result = await prepare({ environmentId: props.environmentId, input: context });
    setBusy(false);
    if (selectionVersion.current !== version) return;
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      setPreview(result.value);
      useComposerDraftStore
        .getState()
        .setKnowledgeContext(target, projectKnowledgeContextRecord(result.value.context));
    }
  };
  const runSearch = () =>
    setSearchInput(
      query.trim().length < 2
        ? null
        : {
            projectId: props.projectId,
            query: query.trim(),
            includeArchived,
            ...(showSuperseded ? { includeSuperseded: true } : {}),
            requestId: CommandId.make(randomUUID()),
          },
    );

  const rankedFacts = search.data?.facts.state === "available" ? search.data.facts.matches : [];
  const facts = searchInput ? rankedFacts.map((match) => match.fact) : (list.data?.facts ?? []);
  const messages = searchInput ? (search.data?.messages.matches ?? []) : [];
  // Search already drops facts whose citations no longer resolve.
  const unavailableReasons = new Map(
    searchInput
      ? []
      : (list.data?.unavailableSources ?? []).map((item) => [item.factId, item.reason]),
  );
  const selectedFactIds = new Set(
    selections.flatMap((item) => (item.kind === "fact" ? [item.factId] : [])),
  );
  const pending = searchInput ? search.isPending : list.isPending;
  const listError = searchInput ? search.error : list.error;
  const lostCount = health.data?.unavailableSources ?? 0;
  const filters: ReadonlyArray<ListFilter> = [
    "saved",
    ...(assistedAvailable ? (["automatic"] as const) : []),
    "forgotten",
    ...(historyAvailable && (lostCount > 0 || filter === "lost") ? (["lost"] as const) : []),
  ];
  const filterLabel = (value: ListFilter) =>
    value === "lost"
      ? `Lost source (${health.data?.unavailableSourcesCoverage === "partial" ? "at least " : ""}${lostCount})`
      : FILTER_LABEL[value];
  const resultSummary = pending
    ? "Reading project knowledge…"
    : searchInput
      ? `${facts.length} ${facts.length === 1 ? "fact" : "facts"} · ${messages.length} ${messages.length === 1 ? "conversation" : "conversations"}`
      : `${facts.length} ${facts.length === 1 ? "fact" : "facts"}`;
  const labelFor = (selection: KnowledgeSelection) => {
    if (selection.kind === "message") return `Message ${selection.messageId}`;
    const content = facts.find((fact) => fact.id === selection.factId)?.content;
    return content ? content.slice(0, 60) : `Fact ${shortFactId(selection.factId)}`;
  };
  const inspectedFactId = inspection.kind === "fact" ? inspection.factId : null;
  const inspectedFact = facts.find((fact) => fact.id === inspectedFactId);
  const inspectedScore = rankedFacts.find((match) => match.fact.id === inspectedFactId)?.score;
  const sourceRef: SourceRef | null = inspection.kind === "source" ? inspection.ref : null;
  const sourceReturnTo = inspection.kind === "source" ? inspection.returnTo : null;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 pb-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <form
            role="search"
            className="flex min-w-48 flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              runSearch();
            }}
          >
            <Input
              aria-label="Search project knowledge"
              data-memory-search
              placeholder="Search facts and conversations"
              size="sm"
              type="search"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              Search
            </Button>
          </form>
          <ToggleGroup
            aria-label="Filter facts"
            value={searchInput ? [] : [filter]}
            onValueChange={(next) => {
              const value = next[0] as ListFilter | undefined;
              if (!value) return;
              setFilter(value);
              setAfterId(undefined);
              setSearchInput(null);
            }}
          >
            {filters.map((value) => (
              <Toggle key={value} value={value}>
                {filterLabel(value)}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={includeArchived}
              onCheckedChange={(checked) => {
                invalidateAttachment();
                setIncludeArchived(checked);
                setSearchInput(null);
              }}
            />
            Include archived conversations
          </label>
          {historyAvailable ? (
            <label className="flex items-center gap-2">
              <Checkbox
                checked={includeSuperseded}
                onCheckedChange={(checked) => {
                  setIncludeSuperseded(checked);
                  setAfterId(undefined);
                  restartSearch(checked);
                }}
              />
              Show superseded
            </label>
          ) : null}
          <div className="ms-auto flex flex-wrap gap-1">
            {health.data || assistedAvailable ? (
              <Button
                aria-controls="project-memory-health"
                aria-expanded={healthOpen}
                size="sm"
                variant="ghost"
                onClick={() => setHealthOpen((value) => !value)}
              >
                Memory health
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => refresh()}>
              Refresh
            </Button>
            <Button
              disabled={!canMutate}
              size="sm"
              variant="outline"
              onClick={() => openEditor({ mode: "create", content: "", sources: [] })}
            >
              New fact
            </Button>
          </div>
        </div>
        {healthOpen ? (
          <div id="project-memory-health" className="flex flex-col gap-3 rounded-lg border p-3">
            {health.data ? <KnowledgeHealthStrip status={health.data} /> : null}
            {assistedAvailable ? (
              <AssistedLearningSection
                environmentId={props.environmentId}
                projectId={props.projectId}
                status={health.data ?? null}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(17rem,2fr)_3fr]">
        <section
          aria-labelledby="project-memory-results"
          className={cn("flex min-h-0 flex-col md:border-e", showDetail && "max-md:hidden")}
        >
          <div className="flex shrink-0 items-baseline justify-between gap-2 px-5 pt-3 pb-2">
            <h3 id="project-memory-results" className="font-medium text-xs">
              {searchInput ? "Search results" : "Project facts"}
            </h3>
            <p role="status" className="text-muted-foreground text-xs">
              {resultSummary}
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-1 px-5 empty:hidden">
            {listError ? (
              <p role="alert" className="text-sm">
                {listError}
              </p>
            ) : null}
            {!searchInput && filter === "lost" ? (
              <p className="text-muted-foreground text-xs">
                Facts whose cited message changed, moved or was deleted.
              </p>
            ) : null}
            {search.data?.facts.state === "unavailable" ? (
              <p className="text-muted-foreground text-xs">
                Fact ranking is unavailable on this environment. Conversation search and saved facts
                remain available.
              </p>
            ) : null}
            {search.data?.facts.state === "available" &&
            search.data.facts.coverage === "partial" ? (
              <p className="text-muted-foreground text-xs">
                Partial coverage. Narrow the query to reach more facts.
              </p>
            ) : null}
          </div>
          <ScrollArea className="flex-1" scrollFade>
            <ProjectMemoryFactList
              facts={facts}
              unavailableReasons={unavailableReasons}
              messages={messages}
              inspectedKey={inspectedRowKey}
              selectedFactIds={selectedFactIds}
              revealFactId={props.focusFact?.id ?? null}
              onInspectFact={inspectFact}
              onInspectMessage={(ref) => openSource(ref, null)}
              onToggleFact={(fact) =>
                toggle({ kind: "fact", factId: fact.id, revision: fact.revision })
              }
            >
              {!pending && !listError && facts.length === 0 && messages.length === 0 ? (
                <p className="px-3 py-6 text-center text-muted-foreground text-sm">
                  {searchInput
                    ? `No matches for “${searchInput.query}”.`
                    : filter === "lost"
                      ? "No facts have lost their source."
                      : `No ${FILTER_LABEL[filter].toLowerCase()} facts.`}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 px-1 empty:hidden">
                {!searchInput && list.data?.nextCursor ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAfterId(list.data?.nextCursor ?? undefined)}
                  >
                    Next facts
                  </Button>
                ) : null}
                {!searchInput && afterId ? (
                  <Button size="sm" variant="ghost" onClick={() => setAfterId(undefined)}>
                    First facts
                  </Button>
                ) : null}
                {searchInput &&
                search.data?.facts.state === "available" &&
                search.data.facts.nextCursor ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={search.isPending}
                    onClick={() => {
                      if (search.data?.facts.state === "available" && search.data.facts.nextCursor)
                        setSearchInput({
                          ...searchInput,
                          requestId: CommandId.make(randomUUID()),
                          factCursor: search.data.facts.nextCursor,
                        });
                    }}
                  >
                    Next fact matches
                  </Button>
                ) : null}
                {searchInput && search.data?.messages.nextCursor ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={search.isPending}
                    onClick={() => {
                      if (search.data?.messages.nextCursor)
                        setSearchInput({ ...searchInput, cursor: search.data.messages.nextCursor });
                    }}
                  >
                    Next conversations
                  </Button>
                ) : null}
              </div>
            </ProjectMemoryFactList>
          </ScrollArea>
        </section>
        <section
          aria-label="Inspector"
          className={cn("flex min-h-0 flex-col", !showDetail && "max-md:hidden")}
        >
          <div className="flex shrink-0 px-3 pt-2 md:hidden">
            <Button size="sm" variant="ghost" onClick={backToList}>
              Back to list
            </Button>
          </div>
          <ScrollArea className="flex-1" scrollFade viewportTabIndex={0}>
            <div className="flex flex-col gap-4 p-5">
              {error ? (
                <p role="alert" className="text-sm">
                  {error}
                </p>
              ) : null}
              {hintNotice ? (
                <section
                  aria-label="Possible conflicts"
                  className="flex flex-col gap-2 rounded-md border p-3"
                >
                  {hintNotice.hints.map((hint) => (
                    <ConflictHintRow
                      key={hint.factId}
                      hint={hint}
                      currentContent={hintNotice.content}
                      onOpenFact={historyAvailable ? inspectFact : null}
                    />
                  ))}
                  <Button
                    className="self-start"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHintNotice(null)}
                  >
                    Dismiss
                  </Button>
                </section>
              ) : null}
              {editor ? (
                <ProjectFactEditor
                  key={editor.key}
                  projectId={props.projectId}
                  seed={editor.seed}
                  historyAvailable={historyAvailable}
                  canMutate={canMutate}
                  busy={busy}
                  onSubmit={(input) => void apply(input, editor)}
                  onCancel={cancelEditor}
                />
              ) : inspection.kind === "fact" ? (
                <FactInspector
                  environmentId={props.environmentId}
                  projectId={props.projectId}
                  factId={inspection.factId}
                  listedFact={inspectedFact}
                  score={inspectedScore}
                  unavailableReason={unavailableReasons.get(inspection.factId)}
                  historyAvailable={historyAvailable}
                  canMutate={canMutate}
                  busy={busy}
                  onEdit={(fact: EditableFact, supersede) =>
                    openEditor({ mode: supersede ? "supersede" : "edit", base: fact })
                  }
                  onRevise={revise}
                  onOpenSource={(ref: KnowledgeMessageRef) => openSource(ref, inspection.factId)}
                  onOpenFact={inspectFact}
                  onBackToResults={() => {
                    setInspection({ kind: "empty" });
                    backToList();
                  }}
                />
              ) : sourceRef ? (
                <SourceInspector
                  source={sourceRef}
                  data={sourceQuery.data}
                  error={sourceQuery.error}
                  selected={selections.some(
                    (item) => selectionKey(item) === messageRowKey(sourceRef),
                  )}
                  canMutate={canMutate}
                  onBack={
                    sourceReturnTo
                      ? () => inspect({ kind: "fact", factId: sourceReturnTo }, true)
                      : null
                  }
                  onToggleSelect={toggle}
                  onSaveAsFact={(text, ref) =>
                    openEditor({
                      mode: "create",
                      content: text.slice(0, 12000),
                      sources: [ref] satisfies ReadonlyArray<KnowledgeFactSource>,
                    })
                  }
                />
              ) : (
                <InspectorEmpty />
              )}
            </div>
          </ScrollArea>
        </section>
      </div>
      <ProjectMemoryDraftFooter
        selections={selections}
        labelFor={labelFor}
        attached={attached !== undefined}
        preview={preview}
        busy={busy}
        onRemove={toggle}
        onClear={() => {
          invalidateAttachment();
          setSelections([]);
        }}
        onAttach={() => void attach()}
      />
    </div>
  );
}
