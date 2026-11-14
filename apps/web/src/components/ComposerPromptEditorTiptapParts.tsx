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
import {
  ComposerCitationExtension,
  ComposerContextReferenceExtension,
  ComposerMarkersExtension,
  ComposerMentionExtension,
  ComposerSkillExtension,
  ComposerUndoGroupingExtension,
  blockquoteInputRule,
  bulletToTaskInputRule,
  headingInputRule,
  horizontalRuleInputRule,
  listMarkerInputRule,
  taskInputRule,
} from "./ComposerPromptEditorTiptap";

export function createComposerExtensions(richText: boolean) {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      link: false,
      orderedList: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
      listKeymap: false,
      undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
      italic: false,
      bold: false,
      strike: false,
    }),
    ComposerUndoGroupingExtension,
    ComposerTextDirectionExtension,
    ComposerMentionExtension,
    ComposerSkillExtension,
    ComposerCitationExtension,
    ComposerContextReferenceExtension,
    ComposerMarkersExtension,
    ...(richText
      ? [
          ComposerBoldSelectionOnlyExtension,
          ComposerItalicExtension,
          ComposerBoldExtension,
          ComposerStrikeExtension,
          ComposerCodeExtension,
          ComposerCodeBlockExtension.extend({
            addNodeView() {
              return ReactNodeViewRenderer(ComposerCodeBlockNodeView, {
                // Tiptap shields only the button; header clicks would move ProseMirror's selection.
                stopEvent: ({ event }) =>
                  event.target instanceof Element &&
                  event.target.closest(".chat-markdown-codeblock-header") !== null,
              });
            },
            // Tiptap's fence rule allows unserializable lists/quotes; use top-level Enter instead.
            addInputRules() {
              return [];
            },
          }),
          composerCodeBlockHighlight({
            resolveTheme: () =>
              resolveDiffThemeName(
                document.documentElement.classList.contains("dark") ? "dark" : "light",
              ),
          }),
          ...ComposerBlockExtensions.map((extension) =>
            extension.name === "blockquote"
              ? extension.extend({
                  addInputRules() {
                    return [blockquoteInputRule];
                  },
                })
              : extension.name === "horizontalRule"
                ? extension.extend({
                    addInputRules() {
                      return [horizontalRuleInputRule];
                    },
                  })
                : extension.name === "heading"
                  ? extension.extend({
                      addInputRules() {
                        return [headingInputRule];
                      },
                    })
                  : extension,
          ),
          ...ComposerListExtensions.map((extension) =>
            extension.name === "listItem"
              ? extension
              : extension.extend({
                  addInputRules() {
                    return this.name === "bulletList"
                      ? [
                          listMarkerInputRule(/^(?<marker>[*+])(?<space>\s)$/, "bulletList"),
                          listMarkerInputRule(
                            /^(?<marker>-)(?<space>[ \t]+)(?<carried>[^\s[])$/,
                            "bulletList",
                          ),
                        ]
                      : [listMarkerInputRule(/^(?<marker>\d+[.)])(?<space>\s)$/, "orderedList")];
                  },
                }),
          ),
          ComposerTaskListExtension,
          ComposerTaskItemExtension.extend({
            addInputRules() {
              return [taskInputRule(this.type), bulletToTaskInputRule];
            },
          }),
        ]
      : []),
  ];
}
