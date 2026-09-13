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
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  rememberComposerDraftSelection,
  setComposerDraftContext,
  setComposerContextImporting,
  useComposerDraft,
} from "../state/use-composer-drafts";
import {
  importComposerContextClipboard,
  type NativeContextClipboard,
} from "../lib/composerContextClipboard";
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
};

export function ComposerEditor({
  draftKey,
  environmentId,
  onOpenMention,
  onOpenAttachment,
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
  const pasteContext = async (clipboard: NativeContextClipboard) => {
    if (!draftKey || importRef.current || props.readOnly || props.editable === false) return;
    const controller = new AbortController();
    importRef.current = controller;
    setImporting(true);
    setComposerContextImporting(draftKey, true);
    try {
      const result = await importComposerContextClipboard(
        clipboard,
        getComposerDraftSnapshot(draftKey).attachments.length,
        controller.signal,
        getComposerDraftSnapshot(draftKey).context?.records.length ?? 0,
      );
      if (!result) {
        insertComposerDraftContext(draftKey, {
          text: clipboard.text,
          context: { version: 1, records: [] },
        });
        return;
      }
      const rejected = appendComposerDraftAttachments(draftKey, result.attachments);
      const ids = new Set(
        getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
      );
      insertComposerDraftContext(draftKey, {
        text: result.text,
        context: {
          version: 1,
          records: result.context.records.filter(
            (record) => !("attachmentId" in record) || ids.has(record.attachmentId),
          ),
        },
      });
      if (result.failures.length > 0 || rejected > 0)
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
          if (draftKey) rememberComposerDraftSelection(draftKey, props.value, selection);
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
export type { ComposerEditorHandle, ComposerEditorSelection } from "../native/T3ComposerEditor";
