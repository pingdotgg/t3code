import { ComposerContextId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { ComposerEditor as NativeComposerEditor } from "../native/T3ComposerEditor";
import type { ComposerEditorProps as NativeComposerEditorProps } from "../native/T3ComposerEditor";
import {
  appendComposerDraftAttachments,
  createComposerDraftContextHistory,
  getComposerDraftAfterSelection,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  insertComposerDraftText,
  rememberComposerDraftSelection,
  setComposerDraftContext,
  setComposerContextImporting,
  useComposerDraft,
} from "../state/use-composer-drafts";
import { importComposerContextClipboard } from "../lib/composerContextClipboard";
import { ComposerContextSheet } from "./ComposerContextSheet";
import { AppText as Text } from "./AppText";
import {
  composerDocumentAttachment,
  composerMentionPath,
  type ComposerDocumentAttachment,
} from "../lib/composerContext";

export type ComposerEditorProps = NativeComposerEditorProps & {
  readonly draftKey?: string | null;
  readonly environmentId?: EnvironmentId;
  readonly onOpenMention?: (path: string) => void;
  /** Documents open in the file screen; pictures, video and PDF keep their native viewers. */
  readonly onOpenAttachment?: (attachment: ComposerDocumentAttachment) => void;
  /**
   * A resting composer is a target to type in, not a document to navigate. Its chips go inert
   * so a draft full of them can still be tapped anywhere to start writing; the caller focuses
   * the editor instead. Chips become live again once the composer is open.
   */
  readonly chipsInert?: boolean;
  /** Called instead of opening a chip while `chipsInert` is set. */
  readonly onInertChipPress?: () => void;
};

export function ComposerEditor({
  draftKey,
  environmentId,
  onOpenMention,
  onOpenAttachment,
  chipsInert,
  onInertChipPress,
  ...props
}: ComposerEditorProps) {
  const draft = useComposerDraft(draftKey ?? null);
  const contextHistory = useMemo(() => createComposerDraftContextHistory(), [draftKey]);
  useEffect(() => () => contextHistory.dispose(), [contextHistory]);
  const changeText = (text: string) => {
    const restored = contextHistory.restore(
      text,
      draftKey ? getComposerDraftSnapshot(draftKey) : draft,
    );
    props.onChangeText(text);
    if (draftKey) {
      setComposerDraftContext(draftKey, restored.context);
      appendComposerDraftAttachments(draftKey, restored.attachments, { allowOverflow: true });
    }
  };
  const [selected, setSelected] = useState<{ source: string; start: number; end: number } | null>(
    null,
  );
  const importRef = useRef<AbortController | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(
    () => () => {
      importRef.current?.abort();
    },
    [draftKey],
  );
  const pasteContext = async (
    clipboard: Parameters<NonNullable<NativeComposerEditorProps["onPasteContext"]>>[0],
  ) => {
    if (!draftKey || importRef.current || props.readOnly || props.editable === false) return;
    const insertion = { text: clipboard.value, ...clipboard.selection };
    const controller = new AbortController();
    importRef.current = controller;
    setImporting(true);
    setComposerContextImporting(draftKey, true);
    try {
      const retained = getComposerDraftAfterSelection(draftKey, insertion);
      const result = await importComposerContextClipboard(
        clipboard,
        retained.attachments.length,
        controller.signal,
        retained.context?.records.length ?? 0,
      );
      if (!result) {
        insertComposerDraftText(draftKey, clipboard.text, insertion);
        return;
      }
      if (!insertComposerDraftContext(draftKey, result, insertion)) {
        Alert.alert(
          "Could not paste context",
          "Remove some attachments or context items from the draft, then paste again.",
        );
        return;
      }
      if (result.failures.length > 0)
        Alert.alert(
          "Some attachments could not be copied",
          "Reconnect to the source environment and copy them again. References without their files are marked unavailable.",
        );
    } catch (error) {
      if (!controller.signal.aborted)
        Alert.alert(
          "Could not paste context",
          error instanceof Error ? error.message : "Try copying again.",
        );
    } finally {
      setComposerContextImporting(draftKey, false);
      importRef.current = null;
      setImporting(false);
    }
  };
  const clipboardFragment = useMemo(
    () =>
      environmentId && draft.context
        ? encodeComposerContextFragment({
            version: 1,
            source: { environmentId },
            records: draft.context.records.map((record) => {
              if (!("attachmentId" in record)) return record;
              const attachment = draft.attachments.find(
                (entry) => entry.id === record.attachmentId,
              );
              return {
                ...record,
                attachmentId:
                  attachment?.uploadEnvironmentId === environmentId
                    ? (attachment.uploadedAttachmentId ?? record.attachmentId)
                    : record.attachmentId,
              };
            }),
          })
        : "",
    [environmentId, draft.context, draft.attachments],
  );
  const selectedReference = selected
    ? collectComposerContextReferences(selected.source)[0]
    : undefined;
  const selectedSkill = selected?.source.startsWith("$")
    ? props.skills?.find((skill) => skill.name === selected.source.slice(1))
    : undefined;
  const record = draft.context?.records.find(
    (entry) => entry.contextId === selectedReference?.contextId,
  );
  return (
    <>
      <NativeComposerEditor
        {...props}
        onChangeText={changeText}
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
          environmentId={environmentId}
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
