import { Extension, InputRule, Node, wrappingInputRule, type JSONContent } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { exitCode, newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { ResolvedPos } from "@tiptap/pm/model";
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
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/composer-logic";
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
  collapsedToFlat,
  ComposerCodeExtension,
  ComposerTaskItemExtension,
  flatToCollapsed,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
  type SkillMeta,
} from "~/composer-rich-text-doc";
import {
  convertCodeFenceOnEnter,
  indentCodeBlock,
  indentedNewlineInCodeBlock,
  selectionInOneCodeBlock,
} from "~/composer-code-block";
import { nextOrderedMarkerText } from "~/composer-list-continuation";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn, isMacPlatform } from "~/lib/utils";
import { basenameOfPath } from "~/pierre-icons";
import {
  COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "./composerInlineChip";
import { FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from "./chat/FileTagChip";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { getTimelinePageScrollKey } from "./chat/pageScrollController";
import { ContextChipPopover } from "./contextChipParts";
import { Button } from "./ui/button";
import {
  ComposerContextActionsContext,
  ComposerContextReferenceChip,
  ComposerContextRecordsContext,
} from "./composerContextPresentation";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerCodeBlockNodeView } from "./chat/ComposerCodeBlockNodeView";
import { composerCodeBlockHighlight } from "./composerCodeBlockHighlight";
import { importPastedComposerText } from "./composerInlineTokenPaste";
import { didComposerSelectionChangeVisibly } from "./composerSelection";
import type { ComposerDraftContextRecords } from "./composerContextPresentation";

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  requestCitationComment: (request: ComposerCitationCommentRequest) => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  /**
   * True when a collapsed caret sits on the first ("start") or last ("end")
   * visual line, counting soft wraps. Prompt history only claims ArrowUp and
   * ArrowDown at these edges so arrows still move the caret inside multiline
   * text.
   */
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

export interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  /**
   * Render Markdown styling (bold, italic, code, strike, task checkboxes).
   * Off renders the same Tiptap engine as plain text: every marker stays a
   * literal character.
   */
  richTextEnabled?: boolean;
  /**
   * Set while a composer-driven flip of `richTextEnabled` is in flight. The
   * flip remounts the editor, and the new instance takes the caret back at
   * the stored cursor. Driven by the control that was clicked so that
   * flipping the same setting from Settings does not pull focus into the
   * composer; the editor clears it through `onFocusRestored`.
   */
  restoreFocusOnMount?: boolean;
  /** Reports that a requested focus restore has been applied. */
  onFocusRestored?: (() => void) | undefined;
  /** Draft records behind the prompt's context references, keyed by context id. */
  contextRecords: ComposerDraftContextRecords;
  /** Structured clipboard payload for the given referenced ids, or null to skip. */
  buildContextClipboardFragment?:
    | ((contextIds: ReadonlyArray<string>) => string | null)
    | undefined;
  /** Imports a structured paste's records; returns ids that changed. */
  importContextFragment?:
    | ((fragment: ComposerContextClipboardFragment) => ReadonlyMap<string, string>)
    | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  containerClassName?: string;
  className?: string;
  placeholderClassName?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
  ) => void;
  onVisibleSelectionChange?: () => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape",
    event: KeyboardEvent,
    isTaskItem?: boolean,
  ) => boolean;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;
  onCitationSubmitAndSend?: () => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
};

type OpenCitationComment = {
  key: string;
  sourceAnchor?: AssistantCitationSourceAnchor;
  removeOnCancel?: boolean;
};

const ComposerCitationCommentContext = createContext<{
  openComment: OpenCitationComment | null;
  onOpenChange: (citeKey: string, open: boolean) => void;
  onSubmitAndSend: () => void;
}>({ openComment: null, onOpenChange: () => {}, onSubmitAndSend: () => {} });

const RichComposerSkillsContext = createContext<ReadonlyArray<ServerProviderSkill>>([]);

const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// ── Inline atom nodes (chips) ─────────────────────────────────────────────

const ComposerMentionExtension = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-mention": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerMentionNodeView);
  },
});

function ComposerMentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const path = (node.attrs.path as string) ?? "";
  const chip = (
    <Button
      variant="chip"
      onClick={() => actions.openMention(path)}
      aria-label={`Preview ${path}`}
      className={`${FILE_TAG_CHIP_CLASS_NAME} cursor-pointer focus-visible:outline-2`}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent
        path={path}
        label={basenameOfPath(path)}
        theme={resolvedThemeFromDocument()}
      />
    </Button>
  );
  return (
    <NodeViewWrapper as="span" className={COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup
          side="top"
          className="max-w-120 whitespace-normal leading-tight wrap-anywhere"
        >
          {path}
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}

const ComposerSkillExtension = Node.create({
  name: "composer-skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-skill]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-skill": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerSkillNodeView);
  },
});

function ComposerSkillNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const skills = use(RichComposerSkillsContext);
  const skillName = (node.attrs.skillName as string) ?? "";
  const skillLabel = (node.attrs.skillLabel as string) || skillName;
  const skillDescription = (node.attrs.skillDescription as string | null) ?? null;
  const skill = skills.find((candidate) => candidate.name === skillName);
  return (
    <NodeViewWrapper as="span" className={COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME}>
      <ContextChipPopover
        accessibleLabel={`Skill ${skillLabel}`}
        triggerClassName={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}
        chip={
          <>
            <span
              aria-hidden="true"
              className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
              dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
            />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{skillLabel}</span>
          </>
        }
      >
        <div className="space-y-3 p-2 text-sm">
          <p className="font-medium">{skillLabel}</p>
          <p>
            {skill?.description ??
              skillDescription ??
              "No description is available for this skill."}
          </p>
          {skill?.path ? (
            <Button variant="outline" size="sm" onClick={() => actions.openMention(skill.path)}>
              View instructions
            </Button>
          ) : null}
        </div>
      </ContextChipPopover>
    </NodeViewWrapper>
  );
}

const ComposerCitationExtension = Node.create({
  name: "composer-citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-citation]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-citation": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerCitationNodeView);
  },
});

function ComposerCitationNodeView({ node, editor, getPos }: NodeViewProps) {
  const commentContext = use(ComposerCitationCommentContext);
  const citation = node.attrs.citation as AssistantCitation;
  const citeKey = node.attrs.citeKey as string;
  const commentTarget =
    commentContext.openComment?.key === citeKey ? commentContext.openComment : null;

  const nodePos = useCallback(() => {
    const pos = typeof getPos === "function" ? getPos() : null;
    return typeof pos === "number" ? pos : null;
  }, [getPos]);

  const onSaveComment = useCallback(
    (comment: string): boolean => {
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
    },
    [editor, nodePos],
  );

  const onRemove = useCallback(() => {
    if (!editor.isEditable) return;
    const pos = nodePos();
    if (pos === null) return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + current.nodeSize })
      .run();
  }, [editor, nodePos]);

  return (
    <NodeViewWrapper
      as="span"
      className="inline-flex min-w-0 max-w-full"
      contentEditable={false}
      spellCheck={false}
      data-composer-citation-chip="true"
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
          ...(commentTarget?.removeOnCancel ? { onCancel: onRemove } : {}),
          onSave: onSaveComment,
          onSaveAndSend: (comment) => {
            if (!onSaveComment(comment)) return false;
            commentContext.onSubmitAndSend();
            return true;
          },
        }}
      />
    </NodeViewWrapper>
  );
}

const ComposerContextReferenceExtension = Node.create({
  name: "composer-context-reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-context-reference]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-context-reference": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerContextReferenceNodeView);
  },
});

function ComposerContextReferenceNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className={COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME}>
      <ComposerContextReferenceChip
        kind={(node.attrs.kind as string) ?? ""}
        contextId={(node.attrs.contextId as string) ?? ""}
        label={(node.attrs.label as string) ?? ""}
      />
    </NodeViewWrapper>
  );
}

// ── Marker reveal (show ** when the cursor is on styled text) ──────────────

type StyledRange = {
  from: number;
  to: number;
  markers: { at: number; side: number; text: string }[];
};

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    // A fence is drawn as a block, not revealed a character at a time, so its
    // delimiters never become marker widgets.
    if (run.nodeName === "codeBlock") continue;
    if (run.openLen > 0) {
      range ??= { from: run.pmPos, to: run.pmPos, markers: [] };
      range.markers.push({
        at: run.pmPos,
        side: -1,
        text: map.value.slice(run.mdStart, run.mdStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.mdStart + run.mdLen;
      range.markers.push({
        at: range.to,
        side: -2,
        text: map.value.slice(end - run.closeLen, end),
      });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

/**
 * A typed marker becomes a list item that remembers the marker it was typed
 * with, so the stored Markdown keeps `*` or `3)` rather than a canonical `-`.
 *
 * `- ` alone is not enough for a dash: it waits for the first character after
 * the space, which it carries into the new item. That is what lets the GFM
 * task gesture `- [ ] ` or `- [x] ` be typed whole and reach the task rule,
 * instead of being cut off by an instant bullet. A `- ` left on its own is
 * still a bullet the next time the draft is rebuilt.
 */
function listMarkerInputRule(find: RegExp, listType: "bulletList" | "orderedList"): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match, chain }) => {
      const marker = match.groups?.marker ?? "-";
      const space = match.groups?.space ?? " ";
      const carried = match.groups?.carried ?? "";
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.name !== "paragraph" || hasAncestor($from, "blockquote")) return null;
      const command = chain()
        .deleteRange(range)
        .wrapInList(
          listType,
          listType === "orderedList" ? { start: Number.parseInt(marker, 10) || 1 } : {},
        )
        .updateAttributes("listItem", { marker, space });
      (carried ? command.insertContent(carried) : command).run();
      return undefined;
    },
  });
}

/**
 * `[ ] ` at the start of an existing bullet item turns it into a task, for
 * items that were already a list when the checkbox was wanted. New tasks are
 * typed whole, `- [ ] `, and reach the task rule directly.
 */
const bulletToTaskInputRule = new InputRule({
  find: /^\[([ xX])\] $/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    const item = $from.node(-1);
    if ($from.parent.type.name !== "paragraph" || item?.type.name !== "listItem") return null;
    // Any bullet converts; the task grammar only knows `-`, so a `*` or `+`
    // item comes back out as `- [ ]`.
    if (!["-", "*", "+"].includes((item.attrs as { marker?: string }).marker ?? "")) return null;
    const indent = typeof item.attrs.indent === "string" ? item.attrs.indent : "";
    chain()
      .deleteRange(range)
      .toggleList("taskList", "taskItem")
      .updateAttributes("taskItem", { checked: (match[1] ?? " ").toLowerCase() === "x", indent })
      .run();
    return undefined;
  },
});

function hasAncestor($pos: ResolvedPos, name: string): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) return true;
  }
  return false;
}

/**
 * `> ` at the start of a top-level paragraph opens a quote. Not inside a list:
 * a quote holds prose lines, and a list item is not one.
 */
const blockquoteInputRule = new InputRule({
  find: /^>(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .wrapIn("blockquote", { prefix: `>${match[1] ?? " "}` })
      .run();
    return undefined;
  },
});

/**
 * `---` becomes a rule as the third dash lands; `***` and `___` need a space
 * after them so typing bold or an underscore is not interrupted, matching
 * Tiptap's own rule. Only at a top-level paragraph: the list and quote
 * serializers have no line to write a rule into. The typed characters are
 * kept as the rule's source, and `setHorizontalRule` adds a paragraph after a
 * rule at the end so the caret has somewhere to go.
 */
const horizontalRuleInputRule = new InputRule({
  find: /^(---|\*\*\*|___)\s?$/,
  handler: ({ state, range, match, chain }) => {
    const source = match[0] ?? "---";
    if (!source.startsWith("---") && !/\s$/.test(source)) return null;
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setHorizontalRule()
      .command(({ tr }) => {
        // The rule is the block before the caret's paragraph.
        const $pos = tr.selection.$from;
        const index = $pos.index(0) - 1;
        if (index < 0) return true;
        const rulePos = $pos.posAtIndex(index, 0);
        const rule = tr.doc.nodeAt(rulePos);
        if (rule?.type.name === "horizontalRule") {
          tr.setNodeMarkup(rulePos, undefined, { ...rule.attrs, source });
        }
        return true;
      })
      .run();
    return undefined;
  },
});

/**
 * `# ` through `###### ` at a top-level paragraph make a heading. The space
 * is required, which is exactly what keeps `#1234` a pull request reference
 * with its picker rather than a heading. Not inside lists or quotes, whose
 * serializers have no line for one.
 */
const headingInputRule = new InputRule({
  find: /^(#{1,6})(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setNode("heading", { level: match[1]?.length ?? 1, space: match[2] ?? " " })
      .run();
    return undefined;
  },
});

/** Whether the caret sits inside a fenced code block. */
function isInCodeBlock(view: EditorView): boolean {
  return view.state.selection.$from.parent.type.spec.code === true;
}

/**
 * Two blank lines at the end of a fence leave it, the way every code editor
 * does. Without this a fence at the end of the prompt is a trap: Enter only
 * ever adds another line and there is no way back to prose.
 */
function exitCodeBlockOnTrailingBlankLines(view: EditorView): boolean {
  const { $from, empty } = view.state.selection;
  if (!empty || $from.parent.type.spec.code !== true) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  if (!$from.parent.textContent.endsWith("\n\n")) return false;
  view.dispatch(view.state.tr.delete($from.pos - 2, $from.pos));
  return exitCode(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
}

const MarkerPluginKey = new PluginKey("composer-rich-markers");

const ComposerMarkerPlugin = new Plugin({
  key: MarkerPluginKey,
  state: {
    init: (_, state) => decorationsForSelection(state.doc, state.selection),
    apply: (tr, old) =>
      tr.docChanged || tr.selectionSet ? decorationsForSelection(tr.doc, tr.selection) : old,
  },
  props: {
    decorations(state) {
      return MarkerPluginKey.getState(state);
    },
  },
});

function decorationsForSelection(
  doc: ProseMirrorNode,
  selection: { from: number; to: number; empty: boolean },
): DecorationSet {
  const decorations: Decoration[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name.startsWith("composer-")) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
        );
        return false;
      }
      return true;
    });
  }
  for (const range of collectStyledRanges(doc)) {
    const active = selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from;
    if (!active) continue;
    for (const { at, side, text } of range.markers) {
      const marker = document.createElement("span");
      marker.className = "composer-rich-marker";
      marker.textContent = text;
      marker.setAttribute("aria-hidden", "true");
      decorations.push(
        Decoration.widget(at, marker, { side, key: `marker-${at}-${side}-${marker.textContent}` }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

const ComposerMarkersExtension = Extension.create({
  name: "composer-rich-markers",
  addProseMirrorPlugins() {
    return [ComposerMarkerPlugin];
  },
});

// Document model (markdown ⇄ ProseMirror) lives in ~/composer-rich-text-doc so
// unit tests can round-trip it without a browser.
// ── Editor component ───────────────────────────────────────────────────────

type TiptapEditor = NonNullable<ReturnType<typeof useEditor>>;

export function ComposerPromptEditorTiptap(props: ComposerPromptEditorProps) {
  // Extensions are creation-time: flipping the setting remounts the editor.
  // Both halves initialize from the controlled Markdown value, so the draft
  // survives the flip.
  return (
    <ComposerPromptEditorTiptapInner key={props.richTextEnabled ? "rich" : "plain"} {...props} />
  );
}

function ComposerPromptEditorTiptapInner(props: ComposerPromptEditorProps) {
  const {
    value,
    cursor,
    richTextEnabled,
    contextRecords,
    buildContextClipboardFragment,
    importContextFragment,
    skills,
    disabled,
    placeholder,
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
    onPaste,
    editorRef,
  } = props;
  // The setting toggles styling, not the engine: both modes are Tiptap.
  // Plain mode disables the mark extensions, so markers stay literal text.
  const richText = richTextEnabled ?? false;

  const onChangeRef = useRef(onChange);
  const onVisibleSelectionChangeRef = useRef(onVisibleSelectionChange);
  const onCommandKeyDownRef = useRef(onCommandKeyDown);
  const buildFragmentRef = useRef(buildContextClipboardFragment);
  const importFragmentRef = useRef(importContextFragment);
  const skillsRef = useRef(skills);
  const latestValueRef = useRef(value);
  // The editor instance for callbacks created before it exists (paste).
  // Effects flush before any user interaction, so this is always set.
  const editorHolder = useRef<TiptapEditor | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onVisibleSelectionChangeRef.current = onVisibleSelectionChange;
  }, [onVisibleSelectionChange]);
  useEffect(() => {
    onCommandKeyDownRef.current = onCommandKeyDown;
  }, [onCommandKeyDown]);
  useEffect(() => {
    buildFragmentRef.current = buildContextClipboardFragment;
  }, [buildContextClipboardFragment]);
  useEffect(() => {
    importFragmentRef.current = importContextFragment;
  }, [importContextFragment]);
  useEffect(() => {
    skillsRef.current = skills;
  }, [skills]);
  useLayoutEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const skillLabelFor = useCallback((name: string): SkillMeta => {
    const normalized = name.startsWith("$") ? name.slice(1) : name;
    const skill = skillsRef.current.find((candidate) => candidate.name === normalized);
    if (!skill) {
      return { label: formatProviderSkillDisplayName({ name: normalized }), description: null };
    }
    const shortDescription = skill.shortDescription?.trim();
    return {
      label: formatProviderSkillDisplayName(skill),
      description: shortDescription || skill.description?.trim() || null,
    };
  }, []);

  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const initialExpandedCursor = expandCollapsedComposerCursor(value, initialCursor);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: initialExpandedCursor,
    contextIds: collectInlineContextIds(value),
  });
  const selectionRangeRef = useRef({ start: initialExpandedCursor, end: initialExpandedCursor });
  const isApplyingControlledUpdateRef = useRef(false);
  const hasAppliedControlledSelectionRef = useRef(false);
  const citationRequestRef = useRef<ComposerCitationCommentRequest | null>(null);
  const [openCitation, setOpenCitation] = useState<OpenCitationComment | null>(null);
  const [isEmpty, setIsEmpty] = useState(value.length === 0);

  const citationCommentActions = useMemo(
    () => ({
      openComment: openCitation,
      onOpenChange: (nodeKey: string, open: boolean) => {
        setOpenCitation((current) => {
          if (open) {
            if (current?.key === nodeKey) return current;
            return { key: nodeKey };
          }
          return current?.key === nodeKey ? null : current;
        });
      },
      onSubmitAndSend: onCitationSubmitAndSend ?? (() => {}),
    }),
    [onCitationSubmitAndSend, openCitation],
  );

  const handleEditorChange = useCallback((updated: TiptapEditor) => {
    const map = serializeEditorDoc(updated.state.doc);
    const { from, to } = updated.state.selection;
    const fromFlat = pmToFlat(map, from);
    const toFlat = pmToFlat(map, to);
    const nextValue = map.value;
    const nextCursor = clampCollapsedComposerCursor(map.value, flatToCollapsed(map, fromFlat));
    const nextExpandedCursor = Math.max(
      0,
      Math.min(map.value.length, flatToMarkdown(map, fromFlat)),
    );
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
      previousSnapshot.contextIds.length === map.contextIds.length &&
      previousSnapshot.contextIds.every((id, index) => id === map.contextIds[index])
    );
    if (isApplyingControlledUpdateRef.current) return;
    if (!snapshotChanged) {
      if (didComposerSelectionChangeVisibly(previousSelectionRange, nextSelectionRange)) {
        onVisibleSelectionChangeRef.current?.();
      }
      return;
    }
    // A selection-only update while a newer prompt waits to be applied (a chip
    // was just inserted through the store) would report stale text and clobber
    // the prompt. Let the controlled rewrite land instead.
    if (previousSnapshot.value === nextValue && nextValue !== latestValueRef.current) {
      return;
    }
    snapshotRef.current = {
      value: nextValue,
      cursor: nextCursor,
      expandedCursor: nextExpandedCursor,
      contextIds: map.contextIds,
    };
    // A fence holds no chips, so nothing in it should summon the mention or
    // command menu: `@` in code is a decorator, not a file. Suppressing the
    // trigger here also keeps the store from inserting a link the block can
    // only show as literal text, which the store would then count as a chip.
    const inCodeBlock = updated.state.selection.$from.parent.type.spec.code === true;
    const suppressTrigger =
      inCodeBlock ||
      isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
      isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
    onChangeRef.current(nextValue, nextCursor, nextExpandedCursor, suppressTrigger, map.contextIds);
  }, []);

  const editorAttributes = useMemo(
    () => ({
      class: cn(
        "composer-tiptap block max-h-50 min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
        className,
      ),
      "data-testid": "composer-editor",
      "data-composer-rich-text": richText ? "true" : "false",
      "aria-placeholder": placeholder,
    }),
    [className, placeholder, richText],
  );

  const editor = useEditor(
    {
      extensions: [
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
          // Plain mode has no marks: typed markers stay literal characters.
          ...(richText ? {} : { bold: false, italic: false, strike: false }),
        }),
        ComposerMentionExtension,
        ComposerSkillExtension,
        ComposerCitationExtension,
        ComposerContextReferenceExtension,
        ComposerMarkersExtension,
        ...(richText
          ? [
              ComposerCodeExtension,
              ComposerCodeBlockExtension.extend({
                addNodeView() {
                  return ReactNodeViewRenderer(ComposerCodeBlockNodeView);
                },
                // Tiptap's own ``` + space rule would open a fence inside a
                // list item or quote, where the serializer has no line for
                // it. Enter on a fence line covers the gesture at top level.
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
                          : [
                              listMarkerInputRule(
                                /^(?<marker>\d+[.)])(?<space>\s)$/,
                                "orderedList",
                              ),
                            ];
                      },
                    }),
              ),
              TaskList,
              ComposerTaskItemExtension.extend({
                addInputRules() {
                  return [
                    wrappingInputRule({
                      find: /^- \[([ xX])\] $/,
                      type: this.type,
                      getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
                    }),
                    bulletToTaskInputRule,
                  ];
                },
              }),
            ]
          : []),
      ],
      content: buildDocJson(
        value,
        (name) => {
          const normalized = name.startsWith("$") ? name.slice(1) : name;
          const found = skills.find((candidate) => candidate.name === normalized);
          if (!found) {
            return {
              label: formatProviderSkillDisplayName({ name: normalized }),
              description: null,
            };
          }
          const shortDescription = found.shortDescription?.trim();
          return {
            label: formatProviderSkillDisplayName(found),
            description: shortDescription || found.description?.trim() || null,
          };
        },
        { styling: richText },
      ),
      editable: !disabled,
      editorProps: {
        attributes: editorAttributes,
        handleKeyDown: (view, event) => {
          if (
            isMacPlatform(navigator.platform) &&
            (event.key === "Home" || event.key === "End") &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing
          ) {
            const selection = window.getSelection();
            if (
              selection?.anchorNode &&
              view.dom.contains(selection.anchorNode) &&
              typeof selection.modify === "function"
            ) {
              event.preventDefault();
              event.stopPropagation();
              selection.modify(
                event.shiftKey ? "extend" : "move",
                event.key === "Home" ? "backward" : "forward",
                "lineboundary",
              );
              if (selection.anchorNode && selection.focusNode) {
                view.dispatch(
                  view.state.tr
                    .setSelection(
                      TextSelection.create(
                        view.state.doc,
                        view.posAtDOM(selection.anchorNode, selection.anchorOffset),
                        view.posAtDOM(selection.focusNode, selection.focusOffset),
                      ),
                    )
                    .scrollIntoView(),
                );
              }
              return true;
            }
          }
          if (
            (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection;
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            const adjacent = direction === -1 ? $from.nodeBefore : $from.nodeAfter;
            if (adjacent?.type.name.startsWith("composer-")) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(
                view.state.tr
                  .setSelection(
                    TextSelection.create(view.state.doc, $from.pos + direction * adjacent.nodeSize),
                  )
                  .scrollIntoView(),
              );
              return true;
            }
          }
          if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
            event.stopPropagation();
            return true;
          }
          // Enter on a focused task checkbox must not send the prompt (or
          // split anything): Space toggles it, Enter does nothing.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            return true;
          }
          // Inside a fence Tab belongs to the code, not to the composer's
          // focus order or its autocomplete.
          if (
            event.key === "Tab" &&
            !event.metaKey &&
            !event.ctrlKey &&
            selectionInOneCodeBlock(view.state)
          ) {
            event.preventDefault();
            event.stopPropagation();
            return indentCodeBlock(view.state, event.shiftKey ? "out" : "in", (tr) =>
              view.dispatch(tr),
            );
          }
          // A fence is multi-line by definition, so Enter belongs to the code
          // rather than to sending: inside a block it makes a line, and on a
          // line that is only an opening fence it opens the block. Sending
          // from inside a fence is still Cmd/Ctrl+Enter, which falls through.
          if (
            event.key === "Enter" &&
            richText &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing
          ) {
            if (selectionInOneCodeBlock(view.state)) {
              event.preventDefault();
              event.stopPropagation();
              const dispatch = (tr: typeof view.state.tr) => view.dispatch(tr.scrollIntoView());
              return (
                exitCodeBlockOnTrailingBlankLines(view) ||
                indentedNewlineInCodeBlock(view.state, dispatch) ||
                newlineInCode(view.state, dispatch)
              );
            }
            if (convertCodeFenceOnEnter(view.state, (tr) => view.dispatch(tr))) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          const handler = onCommandKeyDownRef.current;
          if (event.key === "Enter") {
            const instance = editorHolder.current;
            const isTaskItem = richText && (instance?.isActive("taskItem") ?? false);
            const isListItem = richText && (instance?.isActive("listItem") ?? false);
            const handled = handler?.("Enter", event, isTaskItem || isListItem) ?? false;
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            event.preventDefault();
            if (
              isTaskItem &&
              instance &&
              (instance.commands.splitListItem("taskItem", { checked: false }) ||
                (view.state.selection.$from.parent.content.size === 0 &&
                  instance.commands.liftListItem("taskItem")))
            ) {
              return true;
            }
            if (
              richText &&
              instance &&
              hasAncestor(view.state.selection.$from, "blockquote") &&
              view.state.selection.$from.parent.content.size === 0 &&
              instance.commands.lift("blockquote")
            ) {
              return true;
            }
            if (isListItem && instance) {
              const item = view.state.selection.$from.node(-1);
              const marker = typeof item?.attrs.marker === "string" ? item.attrs.marker : "-";
              const isOrdered = /^\d+[.)]$/.test(marker);
              if (
                instance.commands.splitListItem(
                  "listItem",
                  isOrdered
                    ? { marker: nextOrderedMarkerText(marker), space: " " }
                    : { space: " " },
                ) ||
                (view.state.selection.$from.parent.content.size === 0 &&
                  instance.commands.liftListItem("listItem"))
              ) {
                return true;
              }
            }
            // Split the paragraph so a single newline visibly advances the caret.
            return splitBlockKeepMarks(view.state, (tr) => {
              // The split is programmatic, so the browser won't follow the
              // caret into view on its own.
              view.dispatch(tr.scrollIntoView());
            });
          }
          if (!handler) return false;
          const key =
            event.key === "Tab"
              ? ("Tab" as const)
              : event.key === "ArrowDown"
                ? ("ArrowDown" as const)
                : event.key === "ArrowUp"
                  ? ("ArrowUp" as const)
                  : event.key === "Escape"
                    ? ("Escape" as const)
                    : null;
          if (!key) return false;
          const handled = handler(key, event);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
          return handled;
        },
        handleTextInput: (view, from, to, text) => {
          if (text.length !== 1) return false;
          const closer = SURROUND_CLOSE[text];
          if (!closer || from === to) return false;
          // Never wrap chips or other atoms, and never wrap styled text: the
          // default replace keeps marks intact, wrapping would drop them.
          let touchesSpecial = false;
          view.state.doc.nodesBetween(from, to, (node) => {
            if (
              (node.isAtom && node.isInline && !node.isText) ||
              (node.isText && node.marks.length > 0)
            ) {
              touchesSpecial = true;
              return false;
            }
            return true;
          });
          if (touchesSpecial) return false;
          const map = serializeEditorDoc(view.state.doc);
          const startMd = flatToMarkdown(map, pmToFlat(map, from));
          const endMd = flatToMarkdown(map, pmToFlat(map, to));
          if (selectionTouchesMentionBoundary(map.value, startMd, endMd)) return false;
          const tr = view.state.tr.insertText(closer, to).insertText(text, from);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length, to + text.length));
          view.dispatch(tr);
          return true;
        },
        handlePaste: (view, event) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData || clipboardData.files.length > 0) return false;
          const pastedText = clipboardData.getData("text/plain");
          if (!pastedText) return false;
          event.preventDefault();
          // A fence takes the clipboard verbatim. Running the markdown path
          // here would split the block on newlines, nest a pasted fence and
          // build chips the code block's schema cannot hold anyway.
          if (isInCodeBlock(view)) {
            const { from, to } = view.state.selection;
            view.dispatch(view.state.tr.insertText(pastedText, from, to).scrollIntoView());
            return true;
          }
          const importFragment = importFragmentRef.current;
          let text = importFragment
            ? importPastedComposerText(clipboardData, importFragment)
            : pastedText;
          // Complete chips at paste boundaries just as autocomplete does.
          const tokens = collectComposerPromptInlineTokens(`${text}\n`);
          const lastToken = tokens.at(-1);
          if (
            (lastToken?.type === "mention" || lastToken?.type === "skill") &&
            lastToken.end === text.length
          ) {
            text += " ";
          }
          if (
            (tokens[0]?.type === "mention" || tokens[0]?.type === "skill") &&
            tokens[0].start === 0
          ) {
            const map = serializeEditorDoc(view.state.doc);
            const offset = flatToMarkdown(map, pmToFlat(map, view.state.selection.from));
            if (offset > 0 && !/\s/.test(map.value[offset - 1]!)) text = ` ${text}`;
          }
          const editorInstance = editorHolder.current;
          if (editorInstance) {
            // Inside a list item or quote, pasted block markup has nowhere to
            // go: it stays literal lines the next rebuild reads back.
            const $paste = view.state.selection.$from;
            const nested = ["listItem", "taskItem", "blockquote"].some((name) =>
              hasAncestor($paste, name),
            );
            insertMarkdownParagraphs(
              text,
              skillLabelFor,
              { styling: richText && !nested },
              (content) => {
                editorInstance.commands.insertContent(content);
              },
            );
            scrollTiptapCaretIntoView(editorInstance);
          }
          return true;
        },
      },
      onUpdate: ({ editor: updated }) => {
        handleEditorChange(updated);
      },
      onSelectionUpdate: ({ editor: updated }) => {
        handleEditorChange(updated);
      },
    },
    [],
  );

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    editorHolder.current = editor;
  }, [editor]);

  // Tiptap forwards option changes to the view from a passive effect, so a
  // class change here would reach the ProseMirror element one tick after
  // React commits. The chat composer measures its resting and expanded
  // geometry in layout effects that run first, and it clamps the prompt
  // through `className`, so the attributes are pushed to the view here for
  // those measurements to see the layout they are about to reserve for.
  useLayoutEffect(() => {
    if (!editor?.isInitialized) return;
    editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes]);

  const readSnapshot = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (!editor) return snapshot;
    const map = serializeEditorDoc(editor.state.doc);
    const { from, to } = editor.state.selection;
    const fromFlat = pmToFlat(map, from);
    const next: typeof snapshot = {
      value: map.value,
      cursor: clampCollapsedComposerCursor(map.value, flatToCollapsed(map, fromFlat)),
      expandedCursor: Math.max(0, Math.min(map.value.length, flatToMarkdown(map, fromFlat))),
      contextIds: map.contextIds,
    };
    const toFlat = pmToFlat(map, to);
    selectionRangeRef.current = {
      start: Math.min(next.expandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(next.expandedCursor, flatToMarkdown(map, toFlat)),
    };
    snapshotRef.current = next;
    return next;
  }, [editor]);

  // Controlled value/cursor from the store (history recall, chip insertion…).
  useLayoutEffect(() => {
    if (!editor) return;
    const initialSelection = !hasAppliedControlledSelectionRef.current;
    hasAppliedControlledSelectionRef.current = true;
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    if (
      !initialSelection &&
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor
    ) {
      return;
    }
    const normalizedExpandedCursor = expandCollapsedComposerCursor(value, normalizedCursor);
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
      editor.commands.setContent(buildDocJson(value, skillLabelFor, { styling: richText }), {
        emitUpdate: false,
      });
    }
    const map = serializeEditorDoc(editor.state.doc);
    const flat = collapsedToFlat(map, normalizedCursor);
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
            removeOnCancel: true,
          });
        }
      }
    }
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, editor, richText, skillLabelFor, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      if (!editor) return;
      editor.view.dom.focus({ preventScroll: true });
      // A newer prompt is waiting to be applied (a chip was just inserted
      // through the store). Reporting the editor's stale text now would
      // overwrite that prompt; the pending rewrite places the caret instead.
      if (snapshotRef.current.value !== latestValueRef.current) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      const map = serializeEditorDoc(editor.state.doc);
      const flat = collapsedToFlat(map, boundedCursor);
      editor.commands.setTextSelection(flatToPm(map, flat));
      scrollTiptapCaretIntoView(editor);
      if (boundedCursor === snapshotRef.current.cursor) return;
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        contextIds: snapshotRef.current.contextIds,
      };
      selectionRangeRef.current = {
        start: snapshotRef.current.expandedCursor,
        end: snapshotRef.current.expandedCursor,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.contextIds,
      );
    },
    [editor],
  );

  // This editor was mounted by a composer-driven rich text flip, so take the
  // caret back at the cursor the last one reported. Two things make this less
  // direct than it looks. `useEditor` returns null on its first render and
  // builds the instance in an effect, so the restore has to wait for the
  // instance. And the instance can be rebuilt again right after, which
  // replaces the focused DOM node and drops focus to the body — so this
  // restores for whichever instance is current rather than only the first.
  // The cursor is captured at mount so typing never drags the caret back.
  const [restoreFocusCursor] = useState(() => (props.restoreFocusOnMount ? initialCursor : null));
  const onFocusRestoredRef = useRef(props.onFocusRestored);
  useEffect(() => {
    onFocusRestoredRef.current = props.onFocusRestored;
  });
  useEffect(() => {
    if (restoreFocusCursor === null || !editor) return;
    // Not `focusAt`: that bails before placing the caret whenever the editor's
    // text and the store's disagree, a guard against reporting stale text to
    // the store. A restore reports nothing, so it places the caret directly
    // against the document as it is, clamped by the same coordinate mapping.
    const map = serializeEditorDoc(editor.state.doc);
    const flat = collapsedToFlat(map, clampCollapsedComposerCursor(map.value, restoreFocusCursor));
    editor.commands.setTextSelection(flatToPm(map, flat));
    // ProseMirror's focus, not the DOM's: it writes the selection into the
    // DOM. A raw `dom.focus()` leaves the DOM selection at the start, and the
    // first chip node view to mount makes ProseMirror re-read it from there,
    // which resets the caret and reports a cursor of 0 to the store.
    editor.view.focus();
    scrollTiptapCaretIntoView(editor);
    onFocusRestoredRef.current?.();
  }, [editor, restoreFocusCursor]);

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
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
            removeOnCancel: true,
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
    [editor, focusAt, readSnapshot],
  );

  const handleCopyCut = useCallback(
    (event: React.ClipboardEvent, cut: boolean) => {
      const build = buildFragmentRef.current;
      if (!editor || (cut && !editor.isEditable)) return;
      const clipboardData = event.clipboardData;
      const { from, to } = editor.state.selection;
      if (from === to) return;
      const { doc, schema } = editor.state;
      const slice = doc.slice(from, to);
      const first = slice.content.firstChild;
      const content = first?.isInline
        ? schema.nodes.paragraph!.create(null, slice.content)
        : first?.type.name === "taskItem"
          ? schema.nodes.taskList!.create(null, slice.content)
          : slice.content;
      const text = serializeEditorDoc(doc.type.create(null, content)).value;
      const contextIds = Array.from(new Set(collectInlineContextIds(text)));
      const fragment = contextIds.length > 0 ? build?.(contextIds) : null;
      event.preventDefault();
      clipboardData.setData("text/plain", text);
      if (fragment) {
        clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
        clipboardData.setData("text/html", encodeComposerContextClipboardHtml(text, fragment));
      }
      if (cut) {
        editor.chain().focus().deleteSelection().run();
      }
    },
    [editor],
  );

  return (
    <RichComposerSkillsContext value={skills}>
      <ComposerContextRecordsContext value={contextRecords}>
        <ComposerCitationCommentContext value={citationCommentActions}>
          <div
            className={cn(
              "relative [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] [@media(max-width:39.999rem)_and_(pointer:coarse)]:[font-size:max(var(--font-size-prompt,1rem),16px)]",
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
                  "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75",
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

/**
 * Insert pasted markdown at the selection, rebuilding inline tokens as chips
 * and styled spans as marks.
 *
 * Newlines always become paragraph splits — never trailing hard breaks, which
 * render no visible line — so pasted text lands exactly as typed.
 */
function insertMarkdownParagraphs(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options: { styling: boolean },
  insertContent: (content: JSONContent[] | JSONContent) => void,
): void {
  const blocks = buildTiptapContent(value, skillLabelFor, options);
  if (blocks.length === 1 && blocks[0]?.type === "paragraph") {
    const inline = (blocks[0]?.content ?? []) as JSONContent[];
    if (inline.length === 0) return;
    insertContent(inline);
    return;
  }
  insertContent(blocks as JSONContent[]);
}

/**
 * Follow a programmatically placed caret: native scrolling only happens for
 * real input, so controlled rewrites, pastes, and focus restores scroll the
 * composer to the caret explicitly.
 */
function scrollTiptapCaretIntoView(editor: TiptapEditor): void {
  editor.view.dispatch(editor.state.tr.scrollIntoView());
}

/**
 * Client rect of the caret's visual line, so prompt history keeps claiming
 * ArrowUp/Down only at the first and last soft-wrapped lines.
 */
function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const collapsedRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const collapsedRect = edge === "start" ? collapsedRects.at(-1) : collapsedRects[0];
  if (collapsedRect) return collapsedRect;

  const container = range.startContainer;
  // TEXT_NODE without importing the DOM lib's Node (shadowed by Tiptap's).
  if (container.nodeType === 3) {
    const textNode = container as Text;
    if (textNode.data.length === 0) return null;
    const probeStart = Math.max(
      0,
      Math.min(
        edge === "start" ? range.startOffset : range.startOffset - 1,
        textNode.data.length - 1,
      ),
    );
    const probeRange = document.createRange();
    probeRange.setStart(textNode, probeStart);
    probeRange.setEnd(textNode, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
    const boundingRect = probeRange.getBoundingClientRect();
    return boundingRect.height > 0 ? boundingRect : null;
  }

  if (!(container instanceof HTMLElement)) return null;
  const neighbour =
    container.childNodes[Math.max(0, range.startOffset - 1)] ??
    container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    const isBeforeCaret = neighbour === container.childNodes[range.startOffset - 1];
    const probeStart = isBeforeCaret ? neighbour.data.length - 1 : 0;
    const probeRange = document.createRange();
    probeRange.setStart(neighbour, probeStart);
    probeRange.setEnd(neighbour, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
  }
  const containerRect = container.getBoundingClientRect();
  return containerRect.height > 0 ? containerRect : null;
}
