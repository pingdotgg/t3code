import * as Dialog from "./ui/Dialog";
import { ComposerContextId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  formatComposerModelMention,
  modelMentionOptionsKey,
} from "@t3tools/client-runtime/composer-model-mentions";
import { modelMentionSettings } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { ComposerEditor as NativeComposerEditor } from "../native/T3ComposerEditor";
import type { ComposerEditorProps as NativeComposerEditorProps } from "../native/T3ComposerEditor";
import {
  appendComposerDraftAttachments,
  composerContextImportsAtom,
  createComposerDraftContextHistory,
  getComposerDraftAfterSelection,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  insertComposerDraftText,
  rememberComposerDraftSelection,
  setComposerDraftContext,
  setComposerContextImporting,
  useComposerDraft,
  useComposerDraftResetGeneration,
} from "../state/use-composer-drafts";
import { importComposerContextClipboard } from "../lib/composerContextClipboard";
import { startComposerDraftOperation } from "../state/composerDraftOperations";
import { appAtomRegistry } from "../state/atom-registry";
import { enrichedModelDetails, enrichedModelReference } from "../lib/enrichedLinkPresentation";
import { useModelMentions } from "../state/model-mentions";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";
import { ModelMentionSheet } from "./ModelMentionSheet";
import { useOpenLinkedThread } from "../features/threads/useOpenLinkedThread";
import { useLinkedEnvironments } from "../state/peerLinks";
import { ComposerContextSheet } from "./ComposerContextSheet";
import { AssistantCitationSheet } from "./AssistantCitationSheet";
import {
  finishComposerCitation,
  pendingComposerCitation,
  subscribeComposerCitation,
} from "../state/composerCitations";
import { useOpenAssistantCitationSource } from "../features/threads/useOpenAssistantCitationSource";
import { AppText as Text } from "./ui/AppText";
import {
  composerDocumentAttachment,
  composerMentionPath,
  type ComposerDocumentAttachment,
} from "../lib/composerContext";

export type ComposerEditorProps = NativeComposerEditorProps & {
  readonly draftKey?: string | null;
  readonly hidden?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly onOpenMention?: (path: string) => void;
  readonly onOpenAttachment?: (attachment: ComposerDocumentAttachment) => void;
  readonly chipsInert?: boolean;
  readonly onInertChipPress?: () => void;
};

export function ComposerEditor({
  draftKey,
  hidden,
  environmentId,
  onOpenMention,
  onOpenAttachment,
  chipsInert,
  onInertChipPress,
  ...props
}: ComposerEditorProps) {
  const draft = useComposerDraft(draftKey ?? null);
  const readResetGeneration = useComposerDraftResetGeneration(draftKey ?? null);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferredEnterBehavior = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.composerEnterBehavior
    : undefined;
  const contextHistory = createComposerDraftContextHistory();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the attachment file leases held for native text undo when the history is replaced or unmounts
  useEffect(() => () => contextHistory.dispose(), [contextHistory]);
  const changeText = (text: string) => {
    const restored = contextHistory.restore(
      text,
      draftKey ? getComposerDraftSnapshot(draftKey) : draft,
    );
    props.onChangeText(text);
    if (draftKey) {
      setComposerDraftContext(draftKey, restored.context);
      appendComposerDraftAttachments(draftKey, restored.attachments, { restore: true });
    }
  };
  const [selected, setSelected] = useState<{ source: string; start: number; end: number } | null>(
    null,
  );
  const requestedCitation = useSyncExternalStore(subscribeComposerCitation, () =>
    pendingComposerCitation(draftKey ?? null),
  );
  const [pressedCitation, setPressedCitation] = useState<{
    source: string;
    start: number;
  } | null>(null);
  const openCitation =
    requestedCitation ?? (pressedCitation && { ...pressedCitation, insertedSpaces: null });
  const citation =
    openCitation && props.value.startsWith(openCitation.source, openCitation.start)
      ? collectAssistantCitations(openCitation.source)[0]?.citation
      : undefined;
  const openCitationSource = useOpenAssistantCitationSource();
  const closeCitation = () => {
    setPressedCitation(null);
    if (draftKey) finishComposerCitation(draftKey);
  };
  const replaceCitation = (next: string, removeInsertedSpaces = false) => {
    if (!openCitation) return;
    let start = openCitation.start;
    let end = start + openCitation.source.length;
    const spaces = removeInsertedSpaces ? openCitation.insertedSpaces : null;
    if (spaces?.before && props.value[start - 1] === " ") start -= 1;
    if (spaces?.after && props.value[end] === " ") end += 1;
    changeText(props.value.slice(0, start) + next + props.value.slice(end));
    const caret = start + next.length + (next && props.value[end] === " " ? 1 : 0);
    props.onSelectionChange?.({ start: caret, end: caret });
    closeCitation();
  };
  const saveCitationComment = (comment: string) => {
    if (citation) {
      replaceCitation(serializeAssistantCitation(withAssistantCitationComment(citation, comment)));
    }
  };
  const linkedEnvironments = useLinkedEnvironments(environmentId ?? null);
  const models = useModelMentions(environmentId ?? draft.project?.environmentId, props.value);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [pressedModel, setPressedModel] = useState<{ source: string; start: number } | null>(null);
  const openModel =
    pressedModel && props.value.startsWith(pressedModel.source, pressedModel.start)
      ? enrichedModelReference(pressedModel.source, models)
      : undefined;
  const changeModelOptions = (next: Parameters<typeof modelMentionSettings>[1]) => {
    if (!pressedModel || !openModel) return;
    const { options } = modelMentionSettings(openModel.capabilities, next);
    const source = formatComposerModelMention(openModel.instanceId, openModel.model, options);
    const end = pressedModel.start + pressedModel.source.length;
    changeText(props.value.slice(0, pressedModel.start) + source + props.value.slice(end));
    setPressedModel({ source, start: pressedModel.start });
    const key = modelMentionOptionsKey(openModel.instanceId, openModel.model);
    savePreferences({
      transform: (current) => ({
        modelMentionOptions: { ...current.modelMentionOptions, [key]: options },
      }),
    });
  };
  const contextImports = useAtomValue(composerContextImportsAtom);
  const importing = draftKey ? contextImports[draftKey] === true : false;
  const pasteContext = async (
    clipboard: Parameters<NonNullable<NativeComposerEditorProps["onPasteContext"]>>[0],
  ) => {
    if (
      !draftKey ||
      appAtomRegistry.get(composerContextImportsAtom)[draftKey] ||
      props.readOnly ||
      props.editable === false
    )
      return;
    const insertion = { text: clipboard.value, ...clipboard.selection };
    const operation = startComposerDraftOperation(draftKey);
    const { signal } = operation;
    setComposerContextImporting(draftKey, true);
    const settled = await settlePromise(async () => {
      const retained = getComposerDraftAfterSelection(draftKey, insertion);
      const result = await importComposerContextClipboard(
        clipboard,
        retained.attachments.length,
        signal,
        retained.context?.records.length ?? 0,
        environmentId,
        linkedEnvironments,
      );
      if (signal.aborted) return;
      if (!result) {
        insertComposerDraftText(draftKey, clipboard.text, insertion);
        return;
      }
      if (!insertComposerDraftContext(draftKey, result, insertion)) {
        Dialog.alert(
          "Could not paste context",
          "Remove some attachments or context items from the draft, then paste again.",
        );
        return;
      }
      const warnings: string[] = [];
      if (result.failures.length > 0)
        warnings.push(
          "Some attachments could not be copied. Reconnect to the source environment and copy them again.",
        );
      if (result.skippedThreads.length > 0)
        warnings.push(
          `${result.skippedThreads.map((title) => `"${title}"`).join(", ")} ${result.skippedThreads.length === 1 ? "is" : "are"} on another machine.`,
        );
      if (warnings.length > 0)
        Dialog.alert(
          "Some context is unavailable",
          [...warnings, "Those references are marked unavailable."].join("\n\n"),
        );
    });
    operation.finish();
    setComposerContextImporting(draftKey, false);
    if (AsyncResult.isFailure(settled) && !signal.aborted) {
      const error = squashAtomCommandFailure(settled);
      Dialog.alert(
        "Could not paste context",
        error instanceof Error ? error.message : "Try copying again.",
      );
    }
  };
  const clipboardFragment =
    environmentId && draft.context
      ? encodeComposerContextFragment({
          version: 1,
          source: { environmentId },
          records: draft.context.records.map((record) => {
            if (!("attachmentId" in record)) return record;
            const attachment = draft.attachments.find((entry) => entry.id === record.attachmentId);
            return {
              ...record,
              attachmentId:
                attachment?.uploadEnvironmentId === environmentId
                  ? (attachment.uploadedAttachmentId ?? record.attachmentId)
                  : record.attachmentId,
            };
          }),
        })
      : "";
  const openLinkedThread = useOpenLinkedThread();
  const selectedReference = selected
    ? collectComposerContextReferences(selected.source)[0]
    : undefined;
  const selectedSkillName = selected?.source.match(/^\p{Sc}(.+)$/u)?.[1];
  const selectedSkill = selectedSkillName
    ? props.skills?.find((skill) => skill.name === selectedSkillName)
    : undefined;
  const record = draft.context?.records.find(
    (entry) => entry.contextId === selectedReference?.contextId,
  );
  return (
    <>
      {/* Reset revision history with the recreated iOS view without aborting context imports. */}
      <NativeComposerEditor
        key={hidden ? "hidden" : "visible"}
        {...props}
        models={models}
        enterBehavior={props.enterBehavior ?? preferredEnterBehavior}
        onChangeText={changeText}
        readResetGeneration={readResetGeneration}
        readOnly={props.readOnly || importing}
        onSubmit={importing ? undefined : props.onSubmit}
        clipboardFragment={clipboardFragment ?? undefined}
        onPasteContext={(clipboard) => void pasteContext(clipboard)}
        context={draft.context}
        onContextPress={(selection) => {
          if (chipsInert) {
            onInertChipPress?.();
            return;
          }
          if (collectAssistantCitations(selection.source)[0]?.source === selection.source) {
            setPressedCitation({ source: selection.source, start: selection.start });
            return;
          }
          const path = composerMentionPath(selection.source, draft.context);
          if (path && onOpenMention) {
            onOpenMention(path);
            return;
          }
          const model = enrichedModelReference(selection.source, models);
          if (model) {
            if (
              !props.readOnly &&
              props.editable !== false &&
              model.capabilities?.optionDescriptors?.length
            ) {
              setPressedModel({ source: selection.source, start: selection.start });
            } else {
              Dialog.alert(model.label, enrichedModelDetails(model));
            }
            return;
          }
          const document = composerDocumentAttachment(selection.source, draft.context);
          if (document && onOpenAttachment) {
            onOpenAttachment(document);
            return;
          }
          setSelected(selection);
        }}
        onSelectionChange={(selection) => {
          if (draftKey)
            rememberComposerDraftSelection(
              draftKey,
              getComposerDraftSnapshot(draftKey).text,
              selection,
            );
          props.onSelectionChange?.(selection);
        }}
      />
      {importing ? (
        <Text className="py-2 text-xs text-foreground-muted">Copying context…</Text>
      ) : null}
      {openModel ? (
        <ModelMentionSheet
          model={openModel}
          onChangeOptions={changeModelOptions}
          onClose={() => setPressedModel(null)}
        />
      ) : null}
      {citation ? (
        <AssistantCitationSheet
          key={openCitation?.source}
          citation={citation}
          {...(props.readOnly || props.editable === false
            ? {}
            : {
                editor: {
                  fresh: (openCitation?.insertedSpaces ?? null) !== null,
                  onSave: saveCitationComment,
                  ...(props.onSubmit
                    ? {
                        onSaveAndSend: (comment: string) => {
                          saveCitationComment(comment);
                          requestAnimationFrame(() => props.onSubmit?.(false));
                        },
                      }
                    : {}),
                  onRemove: () => replaceCitation("", true),
                },
              })}
          onGoToSource={() => openCitationSource(citation)}
          onClose={(comment) => {
            if (comment === null) closeCitation();
            else saveCitationComment(comment);
          }}
        />
      ) : null}
      {selected && (selectedReference || selectedSkill) ? (
        <ComposerContextSheet
          label={
            selectedReference?.label ?? selectedSkill?.displayName ?? selectedSkill?.name ?? "Skill"
          }
          record={
            record ??
            (selectedSkill
              ? {
                  version: 1,
                  kind: "skill",
                  contextId: ComposerContextId.make("skill-preview"),
                  label: selectedSkill.name,
                  name: selectedSkill.name,
                }
              : undefined)
          }
          {...(selectedSkill?.description ? { skillDescription: selectedSkill.description } : {})}
          {...(selectedSkill?.path && onOpenMention
            ? {
                onOpenSkill: () => {
                  setSelected(null);
                  onOpenMention(selectedSkill.path!);
                },
              }
            : {})}
          onOpenThread={(thread) => {
            setSelected(null);
            openLinkedThread({
              environmentId: String(thread.environmentId),
              threadId: String(thread.threadId),
            });
          }}
          environmentId={environmentId ?? draft.project?.environmentId}
          projectId={draft.project?.projectId}
          records={draft.context?.records}
          attachments={draft.attachments}
          onClose={() => setSelected(null)}
          onRemove={
            props.readOnly || props.editable === false
              ? undefined
              : () => {
                  if (props.value.slice(selected.start, selected.end) === selected.source) {
                    changeText(
                      props.value.slice(0, selected.start) + props.value.slice(selected.end),
                    );
                    props.onSelectionChange?.({ start: selected.start, end: selected.start });
                  }
                  setSelected(null);
                }
          }
        />
      ) : null}
    </>
  );
}
export type {
  ComposerEditorHandle,
  ComposerEditorSelection,
  ComposerTextPaste,
} from "../native/T3ComposerEditor";
