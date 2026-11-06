import { uuidv4 } from "../lib/uuid";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ProjectFactId,
  type EnvironmentId,
  type KnowledgeConflictHint,
  type KnowledgeMessageRef,
  type KnowledgeSelection,
  type MessageId,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeContextRecord,
  type ProjectKnowledgeMutation,
  type ProjectKnowledgeSource,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  knowledgeSelectionKey,
  knowledgeSelectionState,
  projectKnowledgeComposerReference,
  projectKnowledgeRecordInScope,
  refreshKnowledgeSelection,
  removeProjectKnowledgeReference,
  toggleKnowledgeSelection,
} from "../lib/projectKnowledgeComposer";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
  useComposerDraft,
} from "../state/use-composer-drafts";
import { projectKnowledge } from "../state/projectKnowledge";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import {
  ProjectKnowledgeDraftFooter,
  type DescribedSelection,
} from "./ProjectKnowledgeDraftFooter";
import {
  ProjectFactInspector,
  ProjectKnowledgeSourceInspector,
} from "./ProjectKnowledgeFactDetail";
import {
  ProjectKnowledgeFactEditor,
  factEditorTitle,
  type FactEditorFields,
  type FactEditorMode,
} from "./ProjectKnowledgeFactEditor";
import { ProjectKnowledgeFactList, useProjectKnowledgeBrowse } from "./ProjectKnowledgeFactList";
import { AppText } from "./ui/AppText";
import { Button } from "./ui/Button";
import * as Dialog from "./ui/Dialog";
import { Sheet } from "./ui/Sheet";

type Scope = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  readonly disabled: boolean;
};
type MessageCitation = { readonly threadId: ThreadId; readonly messageId: MessageId };
// The digest is optional so a feed message can be cited before the server has
// hashed it; readSource returns the canonical ref.
type SourceRef = MessageCitation & { readonly digest?: KnowledgeMessageRef["digest"] };
/**
 * The sheet is a small stack: the fact list pushes a fact or source inspector, and editing is its
 * own page so reading a fact never changes it.
 */
type Page =
  | { readonly kind: "list" }
  | { readonly kind: "fact"; readonly factId: ProjectFactId; readonly snapshot: ProjectFact | null }
  | { readonly kind: "source"; readonly ref: SourceRef }
  | { readonly kind: "remember"; readonly ref: SourceRef }
  | { readonly kind: "editor"; readonly mode: FactEditorMode };
type OpenRequest = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  readonly message: MessageCitation | null;
};

// The header and feed ask the composer's entry to open, since the sheet writes to that draft.
const openListeners = new Set<(request: OpenRequest) => void>();
export function requestProjectMemory(request: OpenRequest): void {
  for (const listener of openListeners) listener(request);
}

/** Opens project memory for a composer draft; undefined when the server has no project memory. */
export function useOpenProjectMemory(
  environmentId: EnvironmentId,
  projectId: ProjectId | undefined,
  draftKey: string,
) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const open = useCallback(() => {
    if (projectId) requestProjectMemory({ environmentId, projectId, draftKey, message: null });
  }, [environmentId, projectId, draftKey]);
  return config?.environment.capabilities.projectKnowledge === true && projectId ? open : undefined;
}

export function ProjectKnowledgeEntry(props: Scope) {
  const isFocused = useIsFocused();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const [open, setOpen] = useState<{ readonly seed: MessageCitation | null } | null>(null);
  const { environmentId, projectId, draftKey } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this entry with the header and feed open requests while mounted
  useEffect(() => {
    const listener = (request: OpenRequest) => {
      if (
        isFocused &&
        request.environmentId === environmentId &&
        request.projectId === projectId &&
        request.draftKey === draftKey
      )
        setOpen({ seed: request.message });
    };
    openListeners.add(listener);
    return () => {
      openListeners.delete(listener);
    };
  }, [environmentId, projectId, draftKey, isFocused]);
  if (config?.environment.capabilities.projectKnowledge !== true || !open || !isFocused)
    return null;
  return (
    <ProjectKnowledgeSheet
      key={`${props.environmentId}:${props.projectId}:${props.draftKey}:${open.seed?.messageId ?? ""}`}
      {...props}
      // Older servers lack readFact, status and supersede.
      history={config.environment.capabilities.projectKnowledgeHistory === true}
      assisted={config.environment.capabilities.projectKnowledgeAssistedLearning === true}
      seedMessage={open.seed}
      onClose={() => setOpen(null)}
    />
  );
}

function ProjectKnowledgeSheet(
  props: Scope & {
    readonly history: boolean;
    readonly assisted: boolean;
    readonly seedMessage: MessageCitation | null;
    readonly onClose: () => void;
  },
) {
  const scope = { environmentId: props.environmentId, projectId: props.projectId };
  const draft = useComposerDraft(props.draftKey);
  const attached = draft.context?.records.find(
    (record): record is ProjectKnowledgeContextRecord =>
      record.kind === "project-knowledge" && "knowledge" in record,
  );
  const attachedInScope =
    attached && projectKnowledgeRecordInScope(attached, scope) ? attached : undefined;
  const [selections, setSelections] = useState<ReadonlyArray<KnowledgeSelection>>(
    attachedInScope?.knowledge.selections ?? [],
  );
  // Set when a selection change removed the reference this sheet opened with.
  const [detached, setDetached] = useState(false);
  const [stack, setStack] = useState<ReadonlyArray<Page>>(
    props.seedMessage
      ? [{ kind: "list" }, { kind: "remember", ref: props.seedMessage }]
      : [{ kind: "list" }],
  );
  const page = stack.at(-1)!;
  const [hints, setHints] = useState<{
    readonly factId: ProjectFactId;
    readonly hints: ReadonlyArray<KnowledgeConflictHint>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editorDirty = useRef(false);
  const onEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirty.current = dirty;
  }, []);
  const selectionVersion = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates in-flight selection work when the sheet unmounts
  useEffect(
    () => () => {
      selectionVersion.current += 1;
    },
    [],
  );
  const canMutate = useAtomValue(projectKnowledge.mutate.permissionAtom(props.environmentId));

  const detachDraftReference = () => {
    if (!attachedInScope) return;
    setComposerDraftText(
      props.draftKey,
      removeProjectKnowledgeReference(
        getComposerDraftSnapshot(props.draftKey).text,
        attachedInScope,
      ),
    );
    setDetached(true);
  };
  // What the draft references must never silently differ from what the sheet shows as selected,
  // so any change removes the attached reference, as the web draft selection does.
  const changeSelections = (
    next: (current: ReadonlyArray<KnowledgeSelection>) => ReadonlyArray<KnowledgeSelection>,
  ) => {
    selectionVersion.current += 1;
    setSelections(next);
    detachDraftReference();
  };
  const toggleSelection = (selection: KnowledgeSelection) =>
    changeSelections((current) => toggleKnowledgeSelection(current, selection));
  const refreshSelection = (selection: KnowledgeSelection) =>
    changeSelections((current) => refreshKnowledgeSelection(current, selection));

  const browse = useProjectKnowledgeBrowse({
    environmentId: props.environmentId,
    projectId: props.projectId,
    history: props.history,
    onArchivedChange: () => {
      selectionVersion.current += 1;
      detachDraftReference();
    },
  });
  const detail = useEnvironmentQuery(
    props.history && page.kind === "fact"
      ? projectKnowledge.readFact({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, factId: page.factId },
        })
      : null,
  );
  // The query keeps the previous fact's data while a linked fact loads.
  const detailData =
    page.kind === "fact" && detail.data?.fact.id === page.factId ? detail.data : null;
  const sourceRef = page.kind === "source" || page.kind === "remember" ? page.ref : null;
  const sourceQuery = useEnvironmentQuery(
    sourceRef
      ? projectKnowledge.readSource({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            ...sourceRef,
            includeArchived: browse.includeArchived,
          },
        })
      : null,
  );
  const mutate = useAtomCommand(projectKnowledge.mutate, { reportFailure: false });
  const prepare = useAtomCommand(projectKnowledge.prepareContext, { reportFailure: false });

  const push = (next: Page) => {
    setError(null);
    setStack((current) => [...current, next]);
  };
  const confirmLeavingEditor = (leave: () => void) => {
    if (busy) return;
    if (!editorDirty.current) return leave();
    Dialog.confirm({
      title: "Discard fact changes?",
      message: "Your unsaved fact changes will be lost.",
      confirmText: "Discard",
      destructive: true,
      onConfirm: leave,
    });
  };
  const pop = () =>
    confirmLeavingEditor(() => {
      setError(null);
      setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
    });
  const back = () => {
    if (stack.length < 2) return false;
    pop();
    return true;
  };

  const apply = async (input: ProjectKnowledgeMutation) => {
    selectionVersion.current += 1;
    setBusy(true);
    setError(null);
    const result = await mutate({ environmentId: props.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    const fact = result.value;
    // A revised fact's old revision is no longer what the selection meant, as on web.
    const revised = new Set<ProjectFactId>([input.factId, fact.id]);
    if (selections.some((item) => item.kind === "fact" && revised.has(item.factId)))
      changeSelections((current) =>
        current.filter((item) => item.kind !== "fact" || !revised.has(item.factId)),
      );
    setHints(fact.hints?.length ? { factId: fact.id, hints: fact.hints } : null);
    const inspected: Page = { kind: "fact", factId: fact.id, snapshot: fact };
    setStack((current) => {
      const base = current.filter((item) => item.kind !== "editor" && item.kind !== "remember");
      const top = base.at(-1);
      return top?.kind === "fact" && revised.has(top.factId)
        ? [...base.slice(0, -1), inspected]
        : [...base, inspected];
    });
    browse.refresh();
    detail.refresh();
  };
  const factMutation = (fact: ProjectFact) => ({
    commandId: CommandId.make(uuidv4()),
    projectId: props.projectId,
    factId: fact.id,
    expectedRevision: fact.revision,
  });
  const save = (mode: FactEditorMode, fields: FactEditorFields) => {
    if (mode.kind === "create") {
      void apply({
        action: "create",
        commandId: CommandId.make(uuidv4()),
        projectId: props.projectId,
        factId: ProjectFactId.make(uuidv4()),
        sources: mode.sources,
        ...fields,
      });
      return;
    }
    const base = {
      ...factMutation(mode.fact),
      sources: mode.fact.sources.length ? mode.fact.sources : [{ kind: "user" as const }],
      ...fields,
    };
    void apply(
      mode.kind === "edit"
        ? { action: "edit", ...base }
        : { action: "supersede", replacementFactId: ProjectFactId.make(uuidv4()), ...base },
    );
  };

  const attach = async () => {
    if (props.disabled || selections.length === 0) return;
    const version = ++selectionVersion.current;
    setBusy(true);
    setError(null);
    const result = await prepare({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        projectId: props.projectId,
        selections,
        includeArchived: browse.includeArchived,
        maxBytes: 48_000,
      },
    });
    setBusy(false);
    if (selectionVersion.current !== version) return;
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    if (
      result.value.context.environmentId !== scope.environmentId ||
      result.value.context.projectId !== scope.projectId
    ) {
      setError(
        "The prepared evidence belongs to a different environment or project. Refresh and try again.",
      );
      return;
    }
    const reference = projectKnowledgeComposerReference(result.value.context);
    if (attachedInScope) {
      const current = getComposerDraftSnapshot(props.draftKey);
      setComposerDraftText(
        props.draftKey,
        removeProjectKnowledgeReference(current.text, attachedInScope),
      );
    }
    if (!insertComposerDraftContext(props.draftKey, reference)) {
      setError("Remove a context item before attaching project memory.");
      return;
    }
    props.onClose();
  };

  // The newest version of each item this sheet has loaded, to show selections that went stale.
  const loaded = new Map<
    string,
    { readonly current: KnowledgeSelection; readonly label: string }
  >();
  const track = (current: KnowledgeSelection, label: string) =>
    loaded.set(knowledgeSelectionKey(current), { current, label });
  for (const fact of browse.facts)
    if (fact.status !== "forgotten")
      track({ kind: "fact", factId: fact.id, revision: fact.revision }, fact.content);
  for (const message of browse.messages) track(message.ref, message.snippet);
  if (sourceQuery.data?.state === "available")
    track(sourceQuery.data.source, sourceQuery.data.text);
  const inspectedFact =
    page.kind === "fact"
      ? detailData && detailData.fact.revision >= (page.snapshot?.revision ?? 0)
        ? detailData.fact
        : page.snapshot
      : null;
  if (inspectedFact && inspectedFact.status !== "forgotten")
    track(
      { kind: "fact", factId: inspectedFact.id, revision: inspectedFact.revision },
      inspectedFact.content,
    );
  const described: ReadonlyArray<DescribedSelection> = selections.map((selection) => {
    const known = loaded.get(knowledgeSelectionKey(selection));
    return {
      selection,
      current: known?.current ?? null,
      label:
        known?.label ??
        (selection.kind === "fact"
          ? `Fact ${selection.factId.slice(0, 8)} · revision ${selection.revision}`
          : `Message ${selection.messageId.slice(0, 8)}`),
    };
  });
  const selectionState = (current: KnowledgeSelection) =>
    knowledgeSelectionState(selections, current);

  const title =
    page.kind === "list"
      ? "Project memory"
      : page.kind === "fact"
        ? "Fact"
        : page.kind === "source"
          ? "Source message"
          : page.kind === "remember"
            ? "New fact"
            : factEditorTitle(page.mode);

  return (
    <Sheet
      title={title}
      onClose={props.onClose}
      onBack={back}
      onRequestClose={() => confirmLeavingEditor(props.onClose)}
    >
      <View className="flex-1">
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, gap: 14 }}
        >
          {stack.length > 1 ? (
            <View className="flex-row">
              <Button label="Back" icon="chevron.left" tone="text" onPress={pop} />
            </View>
          ) : null}
          {error ? (
            <AppText accessibilityRole="alert" className="text-danger">
              {error}
            </AppText>
          ) : null}
          {page.kind === "list" ? (
            <ProjectKnowledgeFactList
              environmentId={props.environmentId}
              projectId={props.projectId}
              browse={browse}
              assisted={props.assisted}
              canMutate={canMutate}
              busy={busy}
              selectionState={selectionState}
              onToggleSelection={toggleSelection}
              onRefreshSelection={refreshSelection}
              onInspectFact={(fact) => push({ kind: "fact", factId: fact.id, snapshot: fact })}
              onReadMessage={(ref) => push({ kind: "source", ref })}
              onNewFact={() =>
                push({
                  kind: "editor",
                  mode: { kind: "create", content: "", sources: [{ kind: "user" }] },
                })
              }
            />
          ) : null}
          {page.kind === "fact" ? (
            inspectedFact ? (
              <ProjectFactInspector
                fact={inspectedFact}
                detail={detailData}
                detailError={detail.error}
                history={props.history}
                sourceUnavailable={
                  detailData?.sourceUnavailable ??
                  browse.unavailableReasons.get(inspectedFact.id) ??
                  null
                }
                hints={hints?.factId === inspectedFact.id ? hints.hints : []}
                selection={selectionState({
                  kind: "fact",
                  factId: inspectedFact.id,
                  revision: inspectedFact.revision,
                })}
                canMutate={canMutate}
                busy={busy}
                onToggleSelection={toggleSelection}
                onRefreshSelection={refreshSelection}
                onReadSource={(ref) => push({ kind: "source", ref })}
                onOpenFact={(factId) => push({ kind: "fact", factId, snapshot: null })}
                onEdit={(kind) => {
                  if (inspectedFact.status !== "forgotten")
                    push({ kind: "editor", mode: { kind, fact: inspectedFact } });
                }}
                onForget={() =>
                  Dialog.confirm({
                    title: "Forget this fact permanently?",
                    message:
                      "Its content, history and every copy sent to agents are removed and cannot be restored. If the fact changed rather than became wrong, supersede it instead.",
                    confirmText: "Forget",
                    destructive: true,
                    onConfirm: () =>
                      void apply({ action: "forget", ...factMutation(inspectedFact) }),
                  })
                }
                onFeedback={(helpful) =>
                  void apply({ action: "feedback", helpful, ...factMutation(inspectedFact) })
                }
                onDismissHints={() => setHints(null)}
              />
            ) : detail.error ? (
              <AppText accessibilityRole="alert" className="text-danger">
                {detail.error}
              </AppText>
            ) : (
              <AppText>Reading fact…</AppText>
            )
          ) : null}
          {page.kind === "source" ? (
            <ProjectKnowledgeSourceInspector
              reference={page.ref}
              source={sourceQuery.data ?? null}
              error={sourceQuery.error}
              selections={selections}
              canMutate={canMutate}
              onToggleSelection={toggleSelection}
              onRefreshSelection={refreshSelection}
              onSaveAsFact={(text, source) =>
                push({
                  kind: "editor",
                  mode: { kind: "create", content: text.slice(0, 12_000), sources: [source] },
                })
              }
            />
          ) : null}
          {page.kind === "remember" ? (
            sourceQuery.data ? (
              <RememberEditor
                source={sourceQuery.data}
                canMutate={canMutate}
                busy={busy}
                onSave={save}
                onCancel={pop}
                onDirtyChange={onEditorDirtyChange}
              />
            ) : sourceQuery.error ? (
              <AppText accessibilityRole="alert" className="text-danger">
                {sourceQuery.error}
              </AppText>
            ) : (
              <AppText>Reading message…</AppText>
            )
          ) : null}
          {page.kind === "editor" ? (
            <ProjectKnowledgeFactEditor
              mode={page.mode}
              canMutate={canMutate}
              busy={busy}
              onSave={(fields) => save(page.mode, fields)}
              onCancel={pop}
              onDirtyChange={onEditorDirtyChange}
            />
          ) : null}
        </ScrollView>
        {page.kind === "editor" || page.kind === "remember" ? null : (
          <ProjectKnowledgeDraftFooter
            selections={described}
            attachedLabel={attachedInScope?.label ?? null}
            mismatched={Boolean(attached && !attachedInScope)}
            detached={detached}
            disabled={props.disabled}
            busy={busy}
            onToggle={toggleSelection}
            onRefresh={refreshSelection}
            onAttach={() => void attach()}
            onRemoveAttached={() => {
              if (!attached) return;
              selectionVersion.current += 1;
              setSelections([]);
              setComposerDraftText(
                props.draftKey,
                removeProjectKnowledgeReference(draft.text, attached),
              );
            }}
          />
        )}
      </View>
    </Sheet>
  );
}

/** A remembered feed message opens straight into a new fact citing that message. */
function RememberEditor(props: {
  readonly source: ProjectKnowledgeSource;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onSave: (mode: FactEditorMode, fields: FactEditorFields) => void;
  readonly onCancel: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const mode: FactEditorMode =
    props.source.state === "available"
      ? {
          kind: "create",
          content: props.source.text.slice(0, 12_000),
          sources: [props.source.source],
        }
      : {
          kind: "create",
          content: "",
          sources: [{ kind: "user" }],
          note: "That message can no longer be read, so the fact will be saved as your own assertion.",
        };
  return (
    <ProjectKnowledgeFactEditor
      mode={mode}
      canMutate={props.canMutate}
      busy={props.busy}
      onSave={(fields) => props.onSave(mode, fields)}
      onCancel={props.onCancel}
      onDirtyChange={props.onDirtyChange}
    />
  );
}
