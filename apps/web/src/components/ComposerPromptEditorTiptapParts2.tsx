import { documentChipKindForFileName } from "~/pierre-icons";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import {
  Extension,
  findChildren,
  InputRule,
  Node,
  wrappingInputRule,
  type JSONContent,
  type TiptapEditorHTMLElement,
} from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
import { isHistoryTransaction } from "@tiptap/pm/history";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { NodeType, ResolvedPos } from "@tiptap/pm/model";
import type {
  AssistantCitation,
  ComposerContextClipboardFragment,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  pastedPathQueryLength,
} from "~/composer-logic";
import { useStableCallback } from "~/hooks/useStableCallback";
import { caretLineDirection, ComposerTextDirectionExtension } from "~/composer-text-direction";
import {
  collectComposerPromptInlineTokens,
  selectionTouchesMentionBoundary,
} from "~/composer-editor-mentions";
import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  buildTiptapContent,
  caretTakesMarksBefore,
  ComposerBoldSelectionOnlyExtension,
  convertBulletItemToTask,
  ComposerCodeExtension,
  ComposerBoldExtension,
  ComposerItalicExtension,
  ComposerStrikeExtension,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
  skillChipReplacements,
  splitOrLiftListItem,
  stepCaretAcrossStyledEdge,
  type SkillMeta,
} from "~/composer-rich-text-doc";
import {
  convertCodeFenceOnEnter,
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  indentCodeBlock,
  indentedNewlineInCodeBlock,
  selectionInOneCodeBlock,
} from "~/composer-code-block";
import {
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "~/composer-undo-grouping";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn, isMacPlatform } from "~/lib/utils";
import { basenameOfPath } from "~/pierre-icons";
import { WorkspaceEntryTooltip } from "./chat/WorkspaceEntryIcon";
import { FileTagChipContent } from "./chat/FileTagChip";
import { SkillChipPopover, skillPopoverDescription } from "./chat/SkillInlineText";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { getTimelinePageScrollKey } from "./chat/pageScrollController";
import { ContextChip } from "./ContextChip";
import {
  ComposerContextActionsContext,
  ComposerContextReferenceChip,
  ComposerContextRecordsContext,
} from "./composerContextPresentation";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerCodeBlockNodeView } from "./chat/ComposerCodeBlockNodeView";
import { resolveAssistantCitationCommentDismissal } from "./chat/assistantCitationCommentDismissal";
import { composerCodeBlockHighlight } from "./composerCodeBlockHighlight";
import { importPastedComposerText } from "./composerInlineTokenPaste";
import { didComposerSelectionChangeVisibly } from "./composerSelection";
import type { ComposerDraftContextRecords } from "./composerContextPresentation";
import { createComposerExtensions } from "./ComposerPromptEditorTiptapParts";
import { CHIP_NODE_SELECTION_CLASS_NAME, ComposerCitationCommentContext } from "./ComposerPromptEditorTiptap";

export function ComposerCitationNodeView({ node, editor, getPos }: NodeViewProps) {
  const commentContext = use(ComposerCitationCommentContext);
  const citation = node.attrs.citation as AssistantCitation;
  const citeKey = node.attrs.citeKey as string;
  const commentTarget =
    commentContext.openComment?.key === citeKey ? commentContext.openComment : null;

  const nodePos = () => {
    const pos = typeof getPos === "function" ? getPos() : null;
    return typeof pos === "number" ? pos : null;
  };

  const onSaveComment = (comment: string): boolean => {
    if (!editor.isEditable) return false;
    const pos = nodePos();
    if (pos === null) return false;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "composer-citation") return false;
    const currentCitation = current.attrs.citation as AssistantCitation;
    const next = withAssistantCitationComment(currentCitation, comment);
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
      ...current.attrs,
      citation: next,
      source: serializeAssistantCitation(next),
    });
    editor.view.dispatch(tr);
    return true;
  };

  const removeOnCancel = commentTarget?.removeOnCancel;
  const onRemove = () => {
    if (!editor.isEditable || !removeOnCancel) return;
    const pos = nodePos();
    if (pos === null) return;
    const { doc } = editor.state;
    const current = doc.nodeAt(pos);
    if (!current) return;
    const end = pos + current.nodeSize;
    const from = removeOnCancel.before && doc.textBetween(pos - 1, pos) === " " ? pos - 1 : pos;
    const to = removeOnCancel.after && doc.textBetween(end, end + 1) === " " ? end + 1 : end;
    editor.chain().focus().deleteRange({ from, to }).run();
  };

  const onRestoreFocus = () => {
    if (!editor.isEditable) return;
    const pos = nodePos();
    if (pos === null) return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "composer-citation") return;
    editor.commands.focus(pos + current.nodeSize);
  };

  return (
    <NodeViewWrapper
      as="span"
      className={CHIP_NODE_SELECTION_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-citation-chip="true"
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (
          !editor.isEditable ||
          event.key !== "Tab" ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          !(event.target instanceof HTMLElement) ||
          event.target.dataset.citationCommentTrigger === undefined
        ) {
          return;
        }
        event.preventDefault();
        onRestoreFocus();
      }}
    >
      <AssistantCitationChip
        citation={citation}
        composer
        commentEditor={{
          open: commentTarget !== null,
          sourceAnchor: commentTarget?.sourceAnchor,
          onOpenChange: (open) => {
            if (open && !editor.isEditable) return;
            commentContext.onOpenChange(citeKey, open);
          },
          ...(removeOnCancel ? { onCancel: onRemove } : {}),
          onSave: onSaveComment,
          onDraftChange: (comment) => commentContext.onDraftChange(citeKey, comment),
          onSaveAndSend: (comment) => {
            if (!onSaveComment(comment)) return false;
            commentContext.onSubmitAndSend();
            return true;
          },
          onRestoreFocus,
        }}
      />
    </NodeViewWrapper>
  );
}

