import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import * as Dialog from "./ui/Dialog";
import { ComposerContextId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { AssistantCitationSheet } from "./AssistantCitationSheet";
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
import { mobilePreferencesAtom } from "../state/preferences";
import { useOpenThreadLink } from "../features/threads/useOpenThreadLink";
import { useLinkedEnvironments } from "../state/peerLinks";
import { ComposerContextSheet } from "./ComposerContextSheet";
import { AppText as Text } from "./ui/AppText";
import {
  assistantCitationDraftWithinLimit,
  composerDocumentAttachment,
  composerMentionPath,
  type ComposerDocumentAttachment,
} from "../lib/composerContext";
import { m } from "../i18n/messages";
import type { ModelCameraView } from "@t3tools/client-runtime/model-preview/annotations";

export type ComposerEditorProps = NativeComposerEditorProps & {
  readonly draftKey?: string | null;
  readonly hidden?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly onOpenMention?: (path: string) => void;
  readonly onOpenAttachment?: (attachment: ComposerDocumentAttachment) => void;
  /** Opens a 3D model at the camera an annotation in the draft saved. */
  readonly onOpenModelView?: (path: string, view: ModelCameraView) => void;
  readonly chipsInert?: boolean;
  readonly onInertChipPress?: () => void;
};

export function ComposerEditor({
  draftKey,
  hidden,
  environmentId,
  onOpenMention,
  onOpenAttachment,
  onOpenModelView,
  chipsInert,
  onInertChipPress,
  ...props
}: ComposerEditorProps) {
  const gt = useGT();
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
  const linkedEnvironments = useLinkedEnvironments(environmentId ?? null);
  const models = useModelMentions(environmentId ?? draft.project?.environmentId, props.value);
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
          gt("Could not paste context"),
          gt("Remove some attachments or context items from the draft, then paste again."),
        );
        return;
      }
      const warnings: string[] = [];
      if (result.failures.length > 0)
        warnings.push(
          gt(
            "Some attachments could not be copied. Reconnect to the source environment and copy them again.",
          ),
        );
      if (result.skippedThreads.length > 0)
        warnings.push(
          gt(
            "{count, plural, one {{titles} is on another machine.} other {{titles} are on another machine.}}",
            {
              count: result.skippedThreads.length,
              titles: result.skippedThreads.map((title) => `"${title}"`).join(", "),
            },
          ),
        );
      if (warnings.length > 0)
        Dialog.alert(
          gt("Some context is unavailable"),
          [...warnings, gt("Those references are marked unavailable.")].join("\n\n"),
        );
    });
    operation.finish();
    setComposerContextImporting(draftKey, false);
    if (AsyncResult.isFailure(settled) && !signal.aborted) {
      const error = squashAtomCommandFailure(settled);
      Dialog.alert(
        gt("Could not paste context"),
        error instanceof Error
          ? (errorDisplayMessage(error, m) ?? error.message)
          : gt("Try copying again."),
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
  const openThreadLink = useOpenThreadLink(environmentId ?? null);
  const selectedReference = selected
    ? collectComposerContextReferences(selected.source)[0]
    : undefined;
  const selectedCitation = selected
    ? collectAssistantCitations(selected.source)[0]?.citation
    : undefined;
  const selectedSkillName = selected?.source.match(/^\p{Sc}(.+)$/u)?.[1];
  const selectedSkill = selectedSkillName
    ? props.skills?.find((skill) => skill.name === selectedSkillName)
    : undefined;
  const record = draft.context?.records.find(
    (entry) => entry.contextId === selectedReference?.contextId,
  );
  const removeSelected =
    props.readOnly || props.editable === false
      ? undefined
      : () => {
          if (!selected) return;
          if (props.value.slice(selected.start, selected.end) === selected.source) {
            changeText(props.value.slice(0, selected.start) + props.value.slice(selected.end));
            props.onSelectionChange?.({ start: selected.start, end: selected.start });
          }
          setSelected(null);
        };
  const commentSelectedCitation =
    props.readOnly || props.editable === false || !selected || !selectedCitation
      ? undefined
      : (comment: string) => {
          if (props.value.slice(selected.start, selected.end) !== selected.source) return;
          const next = serializeAssistantCitation(
            withAssistantCitationComment(selectedCitation, comment),
          );
          const text =
            props.value.slice(0, selected.start) + next + props.value.slice(selected.end);
          if (!assistantCitationDraftWithinLimit(text)) {
            Dialog.alert(
              gt("Could not update quote"),
              gt(
                "This comment would make the message too long to send. Shorten the comment or draft.",
              ),
            );
            return;
          }
          const cursor = selected.start + next.length;
          if (draftKey)
            rememberComposerDraftSelection(draftKey, text, { start: cursor, end: cursor });
          changeText(text);
        };
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
          const path = composerMentionPath(selection.source, draft.context);
          if (path && onOpenMention) {
            onOpenMention(path);
            return;
          }
          const model = enrichedModelReference(selection.source, models);
          if (model) {
            Dialog.alert(model.label, enrichedModelDetails(model));
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
        <Text className="py-2 text-xs text-foreground-muted">
          <T>Copying context…</T>
        </Text>
      ) : null}
      {selectedCitation ? (
        <AssistantCitationSheet
          citation={selectedCitation}
          onClose={() => setSelected(null)}
          onRemove={removeSelected}
          onCommentChange={commentSelectedCitation}
          canChangeComment={
            selected && commentSelectedCitation
              ? (comment) =>
                  assistantCitationDraftWithinLimit(
                    props.value.slice(0, selected.start) +
                      serializeAssistantCitation(
                        withAssistantCitationComment(selectedCitation, comment),
                      ) +
                      props.value.slice(selected.end),
                  )
              : undefined
          }
        />
      ) : null}
      {selected && (selectedReference || selectedSkill) ? (
        <ComposerContextSheet
          label={
            selectedReference?.label ??
            selectedSkill?.displayName ??
            selectedSkill?.name ??
            gt("Skill", { $context: "agent skill" })
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
            openThreadLink(thread);
          }}
          {...(onOpenModelView ? { onOpenModelView } : {})}
          environmentId={environmentId ?? draft.project?.environmentId}
          projectId={draft.project?.projectId}
          records={draft.context?.records}
          attachments={draft.attachments}
          onClose={() => setSelected(null)}
          onRemove={removeSelected}
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
