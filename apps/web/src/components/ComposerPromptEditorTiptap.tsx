import { Extension, findChildren } from "@tiptap/core";


import type { AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
} from "~/composer-logic";
import { useStableCallback } from "~/hooks/useStableCallback";

import {
  buildDocJson,
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
  skillChipReplacements,
} from "~/composer-rich-text-doc";

import {
  type ComposerChangeKind,
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "~/composer-undo-grouping";
import { collectInlineContextIds } from "~/lib/composerContextReferences";

import { cn } from "~/lib/utils";

import { getTimelinePageScrollKey } from "./chat/pageScrollController";

import { ComposerContextRecordsContext } from "./composerContextPresentation";

import { resolveAssistantCitationCommentDismissal } from "./chat/assistantCitationCommentDismissal";

import { didComposerSelectionChangeVisibly } from "./composerSelection";

export {
  ComposerCitationExtension,
  ComposerContextReferenceExtension,
  ComposerMarkerPlugin,
  ComposerMarkersExtension,
  ComposerMentionExtension,
  ComposerSkillExtension,
  blockquoteInputRule,
  bulletToTaskInputRule,
  headingInputRule,
  horizontalRuleInputRule,
  listMarkerInputRule,
  taskInputRule,
} from "./ComposerPromptEditorTiptapExtensions";
import { createComposerTiptapEditorOptions } from "./ComposerPromptEditorTiptapOptions";
import {
  composerSkillMeta,
  replaceSkillChips,
  type TiptapEditor,
} from "./ComposerPromptEditorTiptapExtensions";
import {
  ComposerCitationCommentContext,
  RichComposerSkillsContext,
} from "./composerPromptEditorTiptapContexts";
export {
  CHIP_NODE_SELECTION_CLASS_NAME,
  ComposerCitationCommentContext,
} from "./composerPromptEditorTiptapContexts";
import { caretLineRect, scrollTiptapCaretIntoView } from "./ComposerPromptEditorTiptapHelpers";
import {
  type ComposerCitationCommentRequest,
  type ComposerPromptEditorProps,
  type OpenCitationComment,
} from "./ComposerPromptEditorTiptapTypes";
export {
  type ComposerCitationCommentRequest,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptapTypes";
export type { OpenCitationComment } from "./ComposerPromptEditorTiptapTypes";

export function ComposerPromptEditorTiptap(props: ComposerPromptEditorProps) {
  const restoreFocusRef = useRef(false);
  const { onChange: onPromptChange } = props;
  const [selection, setSelection] = useState<{
    value: string;
    cursor: number;
    expandedCursor: number;
  } | null>(null);
  const onChange: ComposerPromptEditorProps["onChange"] = (
    value,
    cursor,
    expandedCursor,
    ...rest
  ) => {
    setSelection({ value, cursor, expandedCursor });
    onPromptChange(value, cursor, expandedCursor, ...rest);
  };
  // Changing text mode remounts the editor. Its collapsed cursor cannot represent
  // a caret inside unknown `$name` text, so retain the exact Markdown offset here.
  return (
    <ComposerPromptEditorTiptapInner
      key={`${props.draftKey ?? ""}:${props.literalText ? "literal" : props.richTextEnabled ? "rich" : "plain"}`}
      {...props}
      restoreFocusRef={restoreFocusRef}
      initialExpandedCursor={
        selection?.value === props.value && selection.cursor === props.cursor
          ? selection.expandedCursor
          : expandCollapsedComposerCursor(props.value, props.cursor, props.literalText)
      }
      onChange={onChange}
    />
  );
}

/** Decide grouping in dispatch middleware before the history plugin applies the transaction. */
export const ComposerUndoGroupingExtension = Extension.create<
  Record<string, never>,
  { previous: ComposerChangeKind | null }
>({
  name: "composer-undo-grouping",
  addStorage() {
    return { previous: null };
  },
  dispatchTransaction({ transaction, next }) {
    this.storage.previous = groupUndoByChangeKind(transaction, this.storage.previous);
    next(transaction);
  },
});

// Module scope keeps extension identity stable; Tiptap hooks read config through this.

function ComposerPromptEditorTiptapInner(
  props: ComposerPromptEditorProps & {
    initialExpandedCursor: number;
    restoreFocusRef: RefObject<boolean>;
  },
) {
  const {
    value,
    cursor,
    richTextEnabled,
    literalText = false,
    contextRecords,
    buildContextClipboardFragment,
    importContextFragment,
    skills,
    disabled,
    placeholder,
    ariaLabel,
    suggestionListId,
    activeSuggestionId,
    isPathQueryActive,
    containerClassName,
    className,
    placeholderClassName,
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCitationSubmitAndSend,
    onCitationDraftSave,
    onPaste,
    editorRef,
    restoreFocusRef,
  } = props;
  const richText = !literalText && (richTextEnabled ?? false);
  const clampEditorCursor = (text: string, position: number) =>
    literalText
      ? Math.max(
          0,
          Math.min(text.length, Number.isFinite(position) ? Math.floor(position) : text.length),
        )
      : clampCollapsedComposerCursor(text, position);
  const expandEditorCursor = (text: string, position: number) =>
    literalText ? position : expandCollapsedComposerCursor(text, position);

  const latestValueRef = useRef(value);
  // Stable so a skills refresh does not rerun the controlled-value effect.
  const skillLabelFor = useStableCallback((name: string) => composerSkillMeta(skills, name));

  const initialCursor = clampEditorCursor(value, cursor);
  const initialExpandedCursor = Math.max(0, Math.min(value.length, props.initialExpandedCursor));
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: initialExpandedCursor,
    contextIds: literalText ? [] : collectInlineContextIds(value),
  });
  const selectionRangeRef = useRef({ start: initialExpandedCursor, end: initialExpandedCursor });
  const isApplyingControlledUpdateRef = useRef(false);
  const hasAppliedControlledSelectionRef = useRef(false);
  const citationRequestRef = useRef<ComposerCitationCommentRequest | null>(null);
  const [openCitation, setOpenCitation] = useState<OpenCitationComment | null>(null);
  const citationDraftRef = useRef<{ key: string; comment: string } | null>(null);
  const [isEmpty, setIsEmpty] = useState(value.length === 0);

  const citationCommentActions = {
    openComment: openCitation,
    onOpenChange: (nodeKey: string, open: boolean) => {
      if (!open && citationDraftRef.current?.key === nodeKey) citationDraftRef.current = null;
      setOpenCitation((current) => {
        if (open) {
          if (current?.key === nodeKey) return current;
          return { key: nodeKey };
        }
        return current?.key === nodeKey ? null : current;
      });
    },
    onDraftChange: (nodeKey: string, comment: string) => {
      citationDraftRef.current = { key: nodeKey, comment };
    },
    onSubmitAndSend: onCitationSubmitAndSend ?? (() => {}),
  };

  // The editor config is built once, so its handlers reach the current callbacks through here.
  const readCallbacks = useStableCallback(() => ({
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    isPathQueryActive,
    importContextFragment,
  }));

  const handleEditorChange = (updated: TiptapEditor) => {
    const map = serializeEditorDoc(updated.state.doc);
    const contextIds = literalText ? [] : [...map.contextIds];
    const { from, to } = updated.state.selection;
    const fromFlat = pmToFlat(map, from);
    const toFlat = pmToFlat(map, to);
    const nextValue = map.value;
    const nextExpandedCursor = Math.max(
      0,
      Math.min(map.value.length, flatToMarkdown(map, fromFlat)),
    );
    const nextCursor = collapseExpandedComposerCursor(map.value, nextExpandedCursor, literalText);
    const nextSelectionRange = {
      start: Math.min(nextExpandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(nextExpandedCursor, flatToMarkdown(map, toFlat)),
    };
    const previousSelectionRange = selectionRangeRef.current;
    selectionRangeRef.current = nextSelectionRange;
    setIsEmpty(nextValue.length === 0);
    const previousSnapshot = snapshotRef.current;
    const snapshotChanged = !(
      previousSnapshot.value === nextValue &&
      previousSnapshot.cursor === nextCursor &&
      previousSnapshot.expandedCursor === nextExpandedCursor &&
      previousSnapshot.contextIds.length === contextIds.length &&
      previousSnapshot.contextIds.every((id, index) => id === contextIds[index])
    );
    if (isApplyingControlledUpdateRef.current) return;
    if (!snapshotChanged) {
      if (didComposerSelectionChangeVisibly(previousSelectionRange, nextSelectionRange)) {
        readCallbacks().onVisibleSelectionChange?.();
      }
      return;
    }
    // Ignore selection-only updates while a controlled rewrite is pending to avoid overwriting the new
    // prompt.
    if (previousSnapshot.value === nextValue && nextValue !== latestValueRef.current) {
      return;
    }
    snapshotRef.current = {
      value: nextValue,
      cursor: nextCursor,
      expandedCursor: nextExpandedCursor,
      contextIds,
    };
    const inCodeBlock = updated.state.selection.$from.parent.type.spec.code === true;
    const suppressTrigger =
      literalText ||
      inCodeBlock ||
      [updated.state.selection.$from.nodeBefore, updated.state.selection.$from.nodeAfter].some(
        (node) => node?.isInline && node.isAtom && !node.isText && node.type.name !== "hardBreak",
      );
    readCallbacks().onChange(
      nextValue,
      nextCursor,
      nextExpandedCursor,
      suppressTrigger,
      contextIds,
    );
  };

  // The editor config is built once; this stable wrapper keeps its handler current.
  const onEditorChange = useStableCallback(handleEditorChange);

  const editorAttributes = {
    class: cn(
      "composer-tiptap -m-1 block max-h-52 min-h-[calc(2lh+--spacing(2))] overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
      className,
    ),
    "data-testid": "composer-editor",
    "data-composer-rich-text": richText ? "true" : "false",
    role: "textbox",
    "aria-multiline": "true",
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(disabled ? { "aria-readonly": "true" } : {}),
    ...(!disabled && suggestionListId
      ? {
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          ...(activeSuggestionId
            ? {
                "aria-controls": suggestionListId,
                "aria-activedescendant": activeSuggestionId,
              }
            : {}),
        }
      : {}),
    "aria-placeholder": placeholder,
  };

  const editor = useEditor(
    createComposerTiptapEditorOptions(
      disabled,
      editorAttributes,
      literalText,
      onEditorChange,
      readCallbacks,
      richText,
      skillLabelFor,
      skills,
      value,
    ),
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the disabled prop into the imperative Tiptap editor via setEditable
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  // Push attributes before layout measurements; Tiptap updates them later in a passive effect.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes DOM attributes into the ProseMirror view before layout measurements read them
  useLayoutEffect(() => {
    if (!editor?.isInitialized) return;
    editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes]);

  const readSnapshot = () => {
    const snapshot = snapshotRef.current;
    if (!editor) return snapshot;
    const map = serializeEditorDoc(editor.state.doc);
    const { from, to } = editor.state.selection;
    const fromFlat = pmToFlat(map, from);
    const expandedCursor = Math.max(0, Math.min(map.value.length, flatToMarkdown(map, fromFlat)));
    const next: typeof snapshot = {
      value: map.value,
      cursor: collapseExpandedComposerCursor(map.value, expandedCursor, literalText),
      expandedCursor,
      contextIds: literalText ? [] : [...map.contextIds],
    };
    const toFlat = pmToFlat(map, to);
    selectionRangeRef.current = {
      start: Math.min(next.expandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(next.expandedCursor, flatToMarkdown(map, toFlat)),
    };
    snapshotRef.current = next;
    return next;
  };

  // Save citation drafts before controlled rewrites unmount their node views.
  const saveCitationDraft = useEffectEvent((current: TiptapEditor, replacedValue: string) => {
    const draft = citationDraftRef.current;
    citationDraftRef.current = null;
    if (!draft || !onCitationDraftSave) return;
    const [target] = findChildren(
      current.state.doc,
      (node) => node.type.name === "composer-citation" && node.attrs.citeKey === draft.key,
    );
    if (!target) return;
    const { node, pos } = target;
    const citation = node.attrs.citation as AssistantCitation;
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason: "none",
      draft: draft.comment,
      savedComment: citation.comment,
    });
    if (dismissal.kind !== "commit") return;
    const next = withAssistantCitationComment(citation, dismissal.comment);
    current.view.dispatch(
      current.state.tr
        .setNodeMarkup(pos, undefined, {
          ...node.attrs,
          citation: next,
          source: serializeAssistantCitation(next),
        })
        .setMeta("addToHistory", false),
    );
    onCitationDraftSave(replacedValue, serializeEditorDoc(current.state.doc).value);
  });

  // The one place the controlled value reaches the editor. Imperative handlers compare against
  // the committed value, so it is recorded here even before the editor exists.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the controlled value and cursor into the Tiptap document before paint
  useLayoutEffect(() => {
    latestValueRef.current = value;
    if (!editor) return;
    const initialSelection = !hasAppliedControlledSelectionRef.current;
    hasAppliedControlledSelectionRef.current = true;
    const normalizedCursor = clampEditorCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    if (
      !initialSelection &&
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor
    ) {
      return;
    }
    const normalizedExpandedCursor = initialSelection
      ? initialExpandedCursor
      : expandEditorCursor(value, normalizedCursor);
    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: normalizedExpandedCursor,
      contextIds: collectInlineContextIds(value),
    };
    selectionRangeRef.current = {
      start: normalizedExpandedCursor,
      end: normalizedExpandedCursor,
    };
    setIsEmpty(value.length === 0);
    const rootElement = editor.view.dom;
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (!initialSelection && previousSnapshot.value === value && !isFocused) return;

    isApplyingControlledUpdateRef.current = true;
    const pendingCitation =
      citationRequestRef.current?.value === value ? citationRequestRef.current : null;
    if (previousSnapshot.value !== value) {
      saveCitationDraft(editor, previousSnapshot.value);
      editor.commands.setContent(
        buildDocJson(value, skillLabelFor, { styling: richText, literalText }),
        {
          emitUpdate: false,
        },
      );
    }
    const map = serializeEditorDoc(editor.state.doc);
    const flat = markdownToFlat(map, normalizedExpandedCursor);
    editor.commands.setTextSelection(flatToPm(map, flat));
    if (isFocused) scrollTiptapCaretIntoView(editor);
    if (pendingCitation) {
      citationRequestRef.current = null;
      const target = map.runs.find(
        (run) =>
          run.kind === "token" &&
          run.nodeName === "composer-citation" &&
          run.mdStart === pendingCitation.citationStart,
      );
      if (target) {
        const node = editor.state.doc.nodeAt(target.pmPos);
        const citeKey = (node?.attrs as { citeKey?: string } | undefined)?.citeKey;
        if (citeKey) {
          setOpenCitation({
            key: citeKey,
            sourceAnchor: pendingCitation.sourceAnchor,
            removeOnCancel: pendingCitation.insertedSpaces,
          });
        }
      }
    }
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [
    clampEditorCursor,
    cursor,
    editor,
    expandEditorCursor,
    initialExpandedCursor,
    literalText,
    richText,
    skillLabelFor,
    value,
  ]);

  // Reconcile loaded or switched provider skills without rebuilding citation node views.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replaces skill chip nodes in the Tiptap document when the provider skill list loads or changes
  useEffect(() => {
    if (!editor || literalText) return;
    const replacements = skillChipReplacements(editor.state.doc, (name) =>
      composerSkillMeta(skills, name),
    );
    if (replacements.length > 0) replaceSkillChips(editor, replacements);
  }, [editor, literalText, skills]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores ProseMirror focus and caret scroll when the keyed editor remounts, capturing focus on teardown
  useLayoutEffect(() => {
    if (!editor) return;
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      editor.view.focus();
      scrollTiptapCaretIntoView(editor);
    }
    return () => {
      // Capture focus before the keyed editor's DOM is removed.
      restoreFocusRef.current = editor.view.hasFocus();
    };
  }, [editor, restoreFocusRef]);

  const focusAt = (nextCursor: number, exactExpandedCursor?: number) => {
    if (!editor) return;
    // view.focus() writes selection immediately; bare DOM focus waits 20ms and can misplace fast dictation.
    editor.view.focus();
    if (snapshotRef.current.value !== latestValueRef.current) return;
    const boundedCursor = clampEditorCursor(snapshotRef.current.value, nextCursor);
    const expandedCursor =
      exactExpandedCursor ?? expandEditorCursor(snapshotRef.current.value, boundedCursor);
    const map = serializeEditorDoc(editor.state.doc);
    editor.commands.setTextSelection(flatToPm(map, markdownToFlat(map, expandedCursor)));
    scrollTiptapCaretIntoView(editor);
    if (boundedCursor === snapshotRef.current.cursor) return;
    snapshotRef.current = {
      value: snapshotRef.current.value,
      cursor: boundedCursor,
      expandedCursor,
      contextIds: snapshotRef.current.contextIds,
    };
    selectionRangeRef.current = {
      start: snapshotRef.current.expandedCursor,
      end: snapshotRef.current.expandedCursor,
    };
    readCallbacks().onChange(
      snapshotRef.current.value,
      boundedCursor,
      snapshotRef.current.expandedCursor,
      literalText,
      snapshotRef.current.contextIds,
    );
  };

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        // The collapsed cursor cannot say where inside `$name` text a caret
        // sits, so restoring the caret passes along its exact offset.
        focusAt(snapshotRef.current.cursor, snapshotRef.current.expandedCursor);
      },
      focusAt: (cursor) => focusAt(cursor),
      focusAtEnd: () => {
        focusAt(
          literalText
            ? snapshotRef.current.value.length
            : collapseExpandedComposerCursor(
                snapshotRef.current.value,
                snapshotRef.current.value.length,
              ),
        );
      },
      readSelectionRange: () => {
        readSnapshot();
        return selectionRangeRef.current;
      },
      requestCitationComment: (request) => {
        citationRequestRef.current = request;
        if (!editor) return;
        const map = serializeEditorDoc(editor.state.doc);
        if (map.value !== request.value) return;
        const target = map.runs.find(
          (run) =>
            run.kind === "token" &&
            run.nodeName === "composer-citation" &&
            run.mdStart === request.citationStart,
        );
        if (!target) return;
        const node = editor.state.doc.nodeAt(target.pmPos);
        const citeKey = (node?.attrs as { citeKey?: string } | undefined)?.citeKey;
        if (citeKey) {
          citationRequestRef.current = null;
          setOpenCitation({
            key: citeKey,
            sourceAnchor: request.sourceAnchor,
            removeOnCancel: request.insertedSpaces,
          });
        }
      },
      readSnapshot,
      isCaretOnVisualEdge: (edge) => {
        const snapshot = readSnapshot();
        if (snapshot.value.length === 0) return true;
        const beforeCaret = snapshot.value.slice(0, snapshot.expandedCursor);
        const afterCaret = snapshot.value.slice(snapshot.expandedCursor);
        if (edge === "start" ? beforeCaret.includes("\n") : afterCaret.includes("\n")) {
          return false;
        }
        const rootElement = editor?.view.dom;
        const selection = window.getSelection();
        if (
          !rootElement ||
          !selection ||
          !selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !selection.anchorNode ||
          !rootElement.contains(selection.anchorNode)
        ) {
          return false;
        }
        const caretRect = caretLineRect(selection.getRangeAt(0), edge);
        if (!caretRect) return false;
        const edgeElement =
          edge === "start" ? rootElement.firstElementChild : rootElement.lastElementChild;
        const edgeRect = (edgeElement ?? rootElement).getBoundingClientRect();
        const threshold = caretRect.height / 2;
        return edge === "start"
          ? caretRect.top - edgeRect.top < threshold
          : edgeRect.bottom - caretRect.bottom < threshold;
      },
    }),
    [editor, focusAt, literalText, readSnapshot],
  );

  const handleCopyCut = (event: React.ClipboardEvent, cut: boolean) => {
    const build = buildContextClipboardFragment;
    if (!editor || (cut && !editor.isEditable)) return;
    const clipboardData = event.clipboardData;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = serializeSelection(editor.state.doc, from, to);
    const contextIds = literalText ? [] : Array.from(new Set(collectInlineContextIds(text)));
    const fragment = contextIds.length > 0 ? build?.(contextIds) : null;
    event.preventDefault();
    clipboardData.setData("text/plain", text);
    if (fragment) {
      clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
      clipboardData.setData("text/html", encodeComposerContextClipboardHtml(text, fragment));
    }
    if (cut) {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          markAsClipboardEdit(tr, "cut");
          return true;
        })
        .deleteSelection()
        .run();
    }
  };

  return (
    <RichComposerSkillsContext value={skills}>
      <ComposerContextRecordsContext value={contextRecords}>
        <ComposerCitationCommentContext value={citationCommentActions}>
          <div
            className={cn(
              "relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
              containerClassName,
            )}
          >
            <EditorContent
              editor={editor}
              onKeyDown={(event) => {
                if (
                  event.key === "Control" ||
                  event.key === "Meta" ||
                  event.key === "Alt" ||
                  event.key === "Shift"
                ) {
                  onPageScrollRelease?.();
                }
                if (event.key !== "PageUp" && event.key !== "PageDown") return;
                const target = event.currentTarget.querySelector(
                  '[data-testid="composer-editor"]',
                ) as HTMLElement | null;
                if (!target) return;
                const pageScrollKey = getTimelinePageScrollKey({
                  altKey: event.altKey,
                  clientHeight: target.clientHeight,
                  ctrlKey: event.ctrlKey,
                  defaultPrevented: event.defaultPrevented,
                  isComposing: event.nativeEvent.isComposing,
                  key: event.key,
                  keyCode: event.keyCode,
                  metaKey: event.metaKey,
                  scrollHeight: target.scrollHeight,
                  scrollTop: target.scrollTop,
                  shiftKey: event.shiftKey,
                });
                if (!pageScrollKey) {
                  onPageScrollRelease?.();
                  return;
                }
                if (!onPageScrollKeyDown) return;
                event.preventDefault();
                onPageScrollKeyDown(pageScrollKey);
              }}
              onKeyUp={(event) => onPageScrollKeyUp?.(event.key)}
              onBlur={onPageScrollRelease}
              onPasteCapture={onPaste}
              onCopyCapture={(event) => handleCopyCut(event, false)}
              onCutCapture={(event) => handleCopyCut(event, true)}
            />
            {isEmpty && contextRecords.size === 0 && placeholder ? (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 leading-relaxed text-placeholder",
                  placeholderClassName,
                )}
              >
                {placeholder}
              </div>
            ) : null}
          </div>
        </ComposerCitationCommentContext>
      </ComposerContextRecordsContext>
    </RichComposerSkillsContext>
  );
}

/** Split newlines into paragraphs; trailing hard breaks render no visible line. */
