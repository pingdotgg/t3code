import * as Dialog from "./ui/Dialog";
import { ComposerContextId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
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
import { mobilePreferencesAtom } from "../state/preferences";
import { useOpenLinkedThread } from "../features/threads/useOpenLinkedThread";
import { ComposerContextSheet } from "./ComposerContextSheet";
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
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferredEnterBehavior = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.composerEnterBehavior
    : undefined;
  const contextHistory = createComposerDraftContextHistory();
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
    const settled = await settlePromise(async () => {
      const retained = getComposerDraftAfterSelection(draftKey, insertion);
      const result = await importComposerContextClipboard(
        clipboard,
        retained.attachments.length,
        controller.signal,
        retained.context?.records.length ?? 0,
        environmentId,
      );
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
    setComposerContextImporting(draftKey, false);
    importRef.current = null;
    setImporting(false);
    if (AsyncResult.isFailure(settled) && !controller.signal.aborted) {
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
        enterBehavior={props.enterBehavior ?? preferredEnterBehavior}
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
