import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { type ServerProviderSkill } from "@t3tools/contracts";
import {
  $applyNodeReplacement,
  $createRangeSelection,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  $getRoot,
  HISTORY_MERGE_TAG,
  DecoratorNode,
  type LexicalEditor,
  type ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
  type EditorState,
  type NodeKey,
  type Spread,
} from "lexical";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  appendComposerDebugEvent,
  clearComposerDebugEntries,
  formatComposerDebugPayload,
  isComposerDebugEnabled,
  readComposerDebugEntries,
} from "~/composerDebugLog";
import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/composer-logic";
import {
  COMPOSER_NATIVE_INPUT_SETTLE_MS,
  type ComposerNativeInputChangeMetadata,
  isComposerNativeComposingKeyEvent,
  shouldLetBrowserHandleComposerBeforeInput,
  shouldSuppressComposerTriggerForNativeInputType,
} from "~/composerNativeInput";
import {
  selectionTouchesMentionBoundary,
  splitPromptIntoComposerSegments,
} from "~/composer-editor-mentions";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { basenameOfPath, getVscodeIconUrlForEntry, inferEntryKindFromPath } from "~/vscode-icons";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "./composerInlineChip";
import { ComposerPendingTerminalContextChip } from "./chat/ComposerPendingTerminalContexts";
import { formatProviderSkillDisplayName } from "~/providerSkillPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;
const SURROUND_SYMBOLS: [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["'", "'"],
  ['"', '"'],
  ["“", "”"],
  ["`", "`"],
  ["<", ">"],
  ["«", "»"],
  ["*", "*"],
  ["_", "_"],
];
const SURROUND_SYMBOLS_MAP = new Map<string, string>(SURROUND_SYMBOLS);
const BACKTICK_SURROUND_CLOSE_SYMBOL = SURROUND_SYMBOLS_MAP.get("`") ?? null;

type SerializedComposerMentionNode = Spread<
  {
    path: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedLexicalNode
>;

type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    skillLabel?: string;
    skillDescription?: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedLexicalNode
>;

type SerializedComposerTerminalContextNode = Spread<
  {
    context: TerminalContextDraft;
    type: "composer-terminal-context";
    version: 1;
  },
  SerializedLexicalNode
>;

const ComposerTerminalContextActionsContext = createContext<{
  onRemoveTerminalContext: (contextId: string) => void;
}>({
  onRemoveTerminalContext: () => {},
});

function ComposerMentionDecorator(props: { path: string }) {
  const theme = resolvedThemeFromDocument();
  const chip = (
    <span
      className={COMPOSER_INLINE_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <img
        alt=""
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        loading="lazy"
        src={getVscodeIconUrlForEntry(props.path, inferEntryKindFromPath(props.path), theme)}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{basenameOfPath(props.path)}</span>
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight wrap-anywhere">
        {props.path}
      </TooltipPopup>
    </Tooltip>
  );
}

class ComposerMentionNode extends DecoratorNode<React.ReactElement> {
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path).updateFromJSON(serializedNode);
  }

  constructor(path: string, key?: NodeKey) {
    super(key);
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    this.__path = normalizedPath;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return `@${this.__path}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): React.ReactElement {
    return <ComposerMentionDecorator path={this.__path} />;
  }
}

function $createComposerMentionNode(path: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path));
}

function resolveSkillDescription(
  skill: Pick<ServerProviderSkill, "shortDescription" | "description">,
): string | null {
  const shortDescription = skill.shortDescription?.trim();
  if (shortDescription) {
    return shortDescription;
  }
  const description = skill.description?.trim();
  return description || null;
}

type ComposerSkillMetadata = {
  label: string;
  description: string | null;
};

function skillMetadataByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyMap<string, ComposerSkillMetadata> {
  return new Map(
    skills.map((skill) => [
      skill.name,
      {
        label: formatProviderSkillDisplayName(skill),
        description: resolveSkillDescription(skill),
      },
    ]),
  );
}

function ComposerSkillDecorator(props: { skillLabel: string; skillDescription: string | null }) {
  const chip = (
    <span
      className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-skill-chip="true"
    >
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.skillLabel}</span>
    </span>
  );

  if (!props.skillDescription) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight">
        {props.skillDescription}
      </TooltipPopup>
    </Tooltip>
  );
}

class ComposerSkillNode extends DecoratorNode<React.ReactElement> {
  __skillName: string;
  __skillLabel: string;
  __skillDescription: string | null;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(
      node.__skillName,
      node.__skillLabel,
      node.__skillDescription,
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $createComposerSkillNode(
      serializedNode.skillName,
      serializedNode.skillLabel ?? serializedNode.skillName,
      serializedNode.skillDescription ?? null,
    ).updateFromJSON(serializedNode);
  }

  constructor(
    skillName: string,
    skillLabel: string,
    skillDescription: string | null,
    key?: NodeKey,
  ) {
    super(key);
    const normalizedSkillName = skillName.startsWith("$") ? skillName.slice(1) : skillName;
    this.__skillName = normalizedSkillName;
    this.__skillLabel = skillLabel;
    this.__skillDescription = skillDescription;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      skillLabel: this.__skillLabel,
      ...(this.__skillDescription ? { skillDescription: this.__skillDescription } : {}),
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return `$${this.__skillName}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): React.ReactElement {
    return (
      <ComposerSkillDecorator
        skillLabel={this.__skillLabel}
        skillDescription={this.__skillDescription}
      />
    );
  }
}

function $createComposerSkillNode(
  skillName: string,
  skillLabel: string,
  skillDescription: string | null,
): ComposerSkillNode {
  return $applyNodeReplacement(new ComposerSkillNode(skillName, skillLabel, skillDescription));
}

function ComposerTerminalContextDecorator(props: { context: TerminalContextDraft }) {
  return <ComposerPendingTerminalContextChip context={props.context} />;
}

class ComposerTerminalContextNode extends DecoratorNode<React.ReactElement> {
  __context: TerminalContextDraft;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__context, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerTerminalContextNode,
  ): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.context);
  }

  constructor(context: TerminalContextDraft, key?: NodeKey) {
    super(key);
    this.__context = context;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return {
      ...super.exportJSON(),
      context: this.__context,
      type: "composer-terminal-context",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): React.ReactElement {
    return <ComposerTerminalContextDecorator context={this.__context} />;
  }
}

function $createComposerTerminalContextNode(
  context: TerminalContextDraft,
): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(context));
}

type ComposerInlineTokenNode =
  | ComposerMentionNode
  | ComposerSkillNode
  | ComposerTerminalContextNode;

function isComposerInlineTokenNode(candidate: unknown): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode ||
    candidate instanceof ComposerSkillNode ||
    candidate instanceof ComposerTerminalContextNode
  );
}

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function terminalContextSignature(contexts: ReadonlyArray<TerminalContextDraft>): string {
  return contexts
    .map((context) =>
      [
        context.id,
        context.threadId,
        context.terminalId,
        context.terminalLabel,
        context.lineStart,
        context.lineEnd,
        context.createdAt,
        context.text,
      ].join("\u001f"),
    )
    .join("\u001e");
}

function skillSignature(skills: ReadonlyArray<ServerProviderSkill>): string {
  return skills
    .map((skill) =>
      [
        skill.name,
        skill.displayName ?? "",
        skill.shortDescription ?? "",
        skill.description ?? "",
        skill.path,
        skill.scope ?? "",
        skill.enabled ? "1" : "0",
      ].join("\u001f"),
    )
    .join("\u001e");
}

function clampExpandedCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}

type ComposerNativeInputTracker = {
  isComposing: boolean;
  lastInputType: string | null;
  suppressTriggerDetectionUntil: number;
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function createComposerNativeInputTracker(): ComposerNativeInputTracker {
  return {
    isComposing: false,
    lastInputType: null,
    suppressTriggerDetectionUntil: 0,
  };
}

function markComposerNativeInputSuppression(
  tracker: ComposerNativeInputTracker,
  inputType: string | null,
): void {
  tracker.lastInputType = inputType;
  tracker.suppressTriggerDetectionUntil = nowMs() + COMPOSER_NATIVE_INPUT_SETTLE_MS;
}

function readComposerNativeInputChangeMetadata(
  tracker: ComposerNativeInputTracker,
): ComposerNativeInputChangeMetadata {
  return {
    suppressTriggerDetection:
      tracker.isComposing || nowMs() < tracker.suppressTriggerDetectionUntil,
    isComposing: tracker.isComposing,
    inputType: tracker.lastInputType,
  };
}

function composerDebugTextTail(value: string): string {
  return value.slice(-80);
}

function composerDebugInputData(data: string | null): { length: number; tail: string } | null {
  return data === null
    ? null
    : {
        length: data.length,
        tail: composerDebugTextTail(data),
      };
}

type ComposerDebugEditorSnapshot = {
  valueLength: number;
  valueTail: string;
  cursor: number;
  expandedCursor: number;
  selectionKind: "range" | "other" | "none";
  selectionCollapsed: boolean | null;
};

function readComposerDebugEditorSnapshot(
  editor: LexicalEditor,
  fallbackCursor: number,
): ComposerDebugEditorSnapshot | null {
  if (!isComposerDebugEnabled()) {
    return null;
  }
  try {
    let snapshot: ComposerDebugEditorSnapshot | null = null;
    editor.getEditorState().read(() => {
      const value = $getRoot().getTextContent();
      const boundedFallback = clampCollapsedComposerCursor(value, fallbackCursor);
      const selection = $getSelection();
      const isRange = $isRangeSelection(selection);
      snapshot = {
        valueLength: value.length,
        valueTail: composerDebugTextTail(value),
        cursor: clampCollapsedComposerCursor(
          value,
          $readSelectionOffsetFromEditorState(boundedFallback),
        ),
        expandedCursor: clampExpandedCursor(
          value,
          $readExpandedSelectionOffsetFromEditorState(
            expandCollapsedComposerCursor(value, boundedFallback),
          ),
        ),
        selectionKind: isRange ? "range" : selection ? "other" : "none",
        selectionCollapsed: isRange ? selection.isCollapsed() : null,
      };
    });
    return snapshot;
  } catch (error) {
    return {
      valueLength: -1,
      valueTail: error instanceof Error ? error.message : "Unable to read editor snapshot",
      cursor: -1,
      expandedCursor: -1,
      selectionKind: "none",
      selectionCollapsed: null,
    };
  }
}

function getComposerInlineTokenTextLength(_node: ComposerInlineTokenNode): 1 {
  return 1;
}

function getComposerInlineTokenExpandedTextLength(node: ComposerInlineTokenNode): number {
  return node.getTextContentSize();
}

function getAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenTextLength(node) : 0);
}

function getExpandedAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenExpandedTextLength(node) : 0);
}

function findSelectionPointForInlineToken(
  node: ComposerInlineTokenNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "element" } | null {
  const parent = node.getParent();
  if (!parent || !$isElementNode(parent)) return null;
  const index = node.getIndexWithinParent();
  if (remainingRef.value === 0) {
    return {
      key: parent.getKey(),
      offset: index,
      type: "element",
    };
  }
  if (remainingRef.value === getComposerInlineTokenTextLength(node)) {
    return {
      key: parent.getKey(),
      offset: index + 1,
      type: "element",
    };
  }
  remainingRef.value -= getComposerInlineTokenTextLength(node);
  return null;
}

function getComposerNodeTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + getComposerNodeTextLength(child), 0);
  }
  return 0;
}

function getComposerNodeExpandedTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenExpandedTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node
      .getChildren()
      .reduce((total, child) => total + getComposerNodeExpandedTextLength(child), 0);
  }
  return 0;
}

function getAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeTextLength(sibling);
    }
    current = nextParent;
  }

  if ($isTextNode(node)) {
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }
  if (isComposerInlineTokenNode(node)) {
    return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeTextLength(child);
    }
    return offset;
  }

  return offset;
}

function getExpandedAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeExpandedTextLength(sibling);
    }
    current = nextParent;
  }

  if ($isTextNode(node)) {
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }
  if (isComposerInlineTokenNode(node)) {
    return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeExpandedTextLength(child);
    }
    return offset;
  }

  return offset;
}

function findSelectionPointAtOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if (isComposerInlineTokenNode(node)) {
    return findSelectionPointForInlineToken(node, remainingRef);
  }

  if ($isTextNode(node)) {
    const size = node.getTextContentSize();
    if (remainingRef.value <= size) {
      return {
        key: node.getKey(),
        offset: remainingRef.value,
        type: "text",
      };
    }
    remainingRef.value -= size;
    return null;
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent) return null;
    const index = node.getIndexWithinParent();
    if (remainingRef.value === 0) {
      return {
        key: parent.getKey(),
        offset: index,
        type: "element",
      };
    }
    if (remainingRef.value === 1) {
      return {
        key: parent.getKey(),
        offset: index + 1,
        type: "element",
      };
    }
    remainingRef.value -= 1;
    return null;
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (const child of children) {
      const point = findSelectionPointAtOffset(child, remainingRef);
      if (point) {
        return point;
      }
    }
    if (remainingRef.value === 0) {
      return {
        key: node.getKey(),
        offset: children.length,
        type: "element",
      };
    }
  }

  return null;
}

function $getComposerRootLength(): number {
  const root = $getRoot();
  const children = root.getChildren();
  return children.reduce((sum, child) => sum + getComposerNodeTextLength(child), 0);
}

function $setSelectionAtComposerOffset(nextOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedOffset = Math.max(0, Math.min(nextOffset, composerLength));
  const remainingRef = { value: boundedOffset };
  const point = findSelectionPointAtOffset(root, remainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function $setSelectionRangeAtComposerOffsets(startOffset: number, endOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedStart = Math.max(0, Math.min(startOffset, composerLength));
  const boundedEnd = Math.max(0, Math.min(endOffset, composerLength));
  const anchorRemainingRef = { value: boundedStart };
  const focusRemainingRef = { value: boundedEnd };
  const anchorPoint = findSelectionPointAtOffset(root, anchorRemainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const focusPoint = findSelectionPointAtOffset(root, focusRemainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const selection = $createRangeSelection();
  selection.anchor.set(anchorPoint.key, anchorPoint.offset, anchorPoint.type);
  selection.focus.set(focusPoint.key, focusPoint.offset, focusPoint.type);
  $setSelection(selection);
}

function getSelectionRangeForExpandedComposerOffsets(selection: ReturnType<typeof $getSelection>): {
  start: number;
  end: number;
} | null {
  if (!$isRangeSelection(selection)) {
    return null;
  }
  const anchorNode = selection.anchor.getNode();
  const focusNode = selection.focus.getNode();
  const anchorOffset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const focusOffset = getExpandedAbsoluteOffsetForPoint(focusNode, selection.focus.offset);
  return {
    start: Math.min(anchorOffset, focusOffset),
    end: Math.max(anchorOffset, focusOffset),
  };
}

function $selectionTouchesInlineToken(selection: ReturnType<typeof $getSelection>): boolean {
  if (!$isRangeSelection(selection)) {
    return false;
  }
  return selection.getNodes().some((node) => isComposerInlineTokenNode(node));
}

function $readSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const composerLength = $getComposerRootLength();
  return Math.max(0, Math.min(offset, composerLength));
}

function $readExpandedSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const expandedLength = $getRoot().getTextContent().length;
  return Math.max(0, Math.min(offset, expandedLength));
}

function $appendTextWithLineBreaks(parent: ElementNode, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0) {
      parent.append($createTextNode(line));
    }
    if (index < lines.length - 1) {
      parent.append($createLineBreakNode());
    }
  }
}

function $setComposerEditorPrompt(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
  skillMetadata: ReadonlyMap<string, ComposerSkillMetadata>,
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const segments = splitPromptIntoComposerSegments(prompt, terminalContexts);
  for (const segment of segments) {
    if (segment.type === "mention") {
      paragraph.append($createComposerMentionNode(segment.path));
      continue;
    }
    if (segment.type === "skill") {
      const metadata = skillMetadata.get(segment.name);
      paragraph.append(
        $createComposerSkillNode(
          segment.name,
          metadata?.label ?? formatProviderSkillDisplayName({ name: segment.name }),
          metadata?.description ?? null,
        ),
      );
      continue;
    }
    if (segment.type === "terminal-context") {
      if (segment.context) {
        paragraph.append($createComposerTerminalContextNode(segment.context));
      }
      continue;
    }
    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

function collectTerminalContextIds(node: LexicalNode): string[] {
  if (node instanceof ComposerTerminalContextNode) {
    return [node.__context.id];
  }
  if ($isElementNode(node)) {
    return node.getChildren().flatMap((child) => collectTerminalContextIds(child));
  }
  return [];
}

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  className?: string;
  onRemoveTerminalContext: (contextId: string) => void;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
    metadata: ComposerNativeInputChangeMetadata,
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
      event: KeyboardEvent | null,
    ): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }
      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
    };
  }, [editor, props]);

  return null;
}

function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const { onRemoveTerminalContext } = use(ComposerTerminalContextActionsContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}

function ComposerNativeInputPlugin(props: {
  nativeInputTrackerRef: React.RefObject<ComposerNativeInputTracker>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const markInputType = (inputType: string | null) => {
      const tracker = props.nativeInputTrackerRef.current;
      if (!tracker) return;
      tracker.lastInputType = inputType;
      if (shouldSuppressComposerTriggerForNativeInputType(inputType)) {
        markComposerNativeInputSuppression(tracker, inputType);
      }
    };

    const onBeforeInput = (event: InputEvent) => {
      markInputType(event.inputType);
      const browserHandled = shouldLetBrowserHandleComposerBeforeInput(event.inputType);
      appendComposerDebugEvent("native.beforeinput", {
        inputType: event.inputType,
        data: composerDebugInputData(event.data),
        isComposing: event.isComposing,
        browserHandled,
        snapshot: readComposerDebugEditorSnapshot(editor, 0),
      });
      if (!browserHandled) {
        return;
      }
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      markInputType(inputEvent.inputType ?? null);
      appendComposerDebugEvent("native.input", {
        inputType: inputEvent.inputType ?? null,
        data: composerDebugInputData(inputEvent.data ?? null),
        isComposing: inputEvent.isComposing,
        snapshot: readComposerDebugEditorSnapshot(editor, 0),
      });
    };

    const onCompositionStart = () => {
      const tracker = props.nativeInputTrackerRef.current;
      if (!tracker) return;
      tracker.isComposing = true;
      markComposerNativeInputSuppression(tracker, tracker.lastInputType);
      appendComposerDebugEvent("native.compositionstart", {
        inputType: tracker.lastInputType,
        snapshot: readComposerDebugEditorSnapshot(editor, 0),
      });
    };

    const onCompositionEnd = () => {
      const tracker = props.nativeInputTrackerRef.current;
      if (!tracker) return;
      tracker.isComposing = false;
      markComposerNativeInputSuppression(tracker, tracker.lastInputType);
      appendComposerDebugEvent("native.compositionend", {
        inputType: tracker.lastInputType,
        snapshot: readComposerDebugEditorSnapshot(editor, 0),
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const composingKey = isComposerNativeComposingKeyEvent(event);
      if (
        composingKey ||
        event.key === " " ||
        event.code === "Space" ||
        event.key === "Backspace" ||
        event.key === "Enter"
      ) {
        appendComposerDebugEvent("native.keydown", {
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          which: event.which,
          isComposing: event.isComposing,
          composingKey,
          snapshot: readComposerDebugEditorSnapshot(editor, 0),
        });
      }
      if (!composingKey) {
        return;
      }
      const tracker = props.nativeInputTrackerRef.current;
      if (!tracker) return;
      markComposerNativeInputSuppression(tracker, tracker.lastInputType);
    };

    let activeRootElement: HTMLElement | null = null;
    let lastSelectionLogAt = 0;
    const onSelectionChange = () => {
      if (!isComposerDebugEnabled()) {
        return;
      }
      if (!activeRootElement || document.activeElement !== activeRootElement) {
        return;
      }
      const timestamp = nowMs();
      if (timestamp - lastSelectionLogAt < 40) {
        return;
      }
      lastSelectionLogAt = timestamp;
      appendComposerDebugEvent("dom.selectionchange", {
        snapshot: readComposerDebugEditorSnapshot(editor, 0),
      });
    };
    const unregisterRootListener = editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("beforeinput", onBeforeInput, true);
      prevRootElement?.removeEventListener("input", onInput);
      prevRootElement?.removeEventListener("compositionstart", onCompositionStart);
      prevRootElement?.removeEventListener("compositionend", onCompositionEnd);
      prevRootElement?.removeEventListener("keydown", onKeyDown, true);
      rootElement?.addEventListener("beforeinput", onBeforeInput, true);
      rootElement?.addEventListener("input", onInput);
      rootElement?.addEventListener("compositionstart", onCompositionStart);
      rootElement?.addEventListener("compositionend", onCompositionEnd);
      rootElement?.addEventListener("keydown", onKeyDown, true);
      activeRootElement = rootElement;
    });
    document.addEventListener("selectionchange", onSelectionChange);

    return () => {
      if (activeRootElement) {
        activeRootElement.removeEventListener("beforeinput", onBeforeInput, true);
        activeRootElement.removeEventListener("input", onInput);
        activeRootElement.removeEventListener("compositionstart", onCompositionStart);
        activeRootElement.removeEventListener("compositionend", onCompositionEnd);
        activeRootElement.removeEventListener("keydown", onKeyDown, true);
      }
      document.removeEventListener("selectionchange", onSelectionChange);
      unregisterRootListener();
    };
  }, [editor, props.nativeInputTrackerRef]);

  return null;
}

function ComposerSurroundSelectionPlugin(props: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const [editor] = useLexicalComposerContext();
  const terminalContextsRef = useRef(props.terminalContexts);
  const skillMetadataRef = useRef(skillMetadataByName(props.skills));
  const pendingSurroundSelectionRef = useRef<{
    value: string;
    expandedStart: number;
    expandedEnd: number;
  } | null>(null);
  const pendingDeadKeySelectionRef = useRef<{
    value: string;
    expandedStart: number;
    expandedEnd: number;
  } | null>(null);

  useEffect(() => {
    terminalContextsRef.current = props.terminalContexts;
  }, [props.terminalContexts]);

  useEffect(() => {
    skillMetadataRef.current = skillMetadataByName(props.skills);
  }, [props.skills]);

  const applySurroundInsertion = useEffectEvent((inputData: string): boolean => {
    const surroundCloseSymbol = SURROUND_SYMBOLS_MAP.get(inputData);
    const pendingSurroundSelection = pendingSurroundSelectionRef.current;
    if (!surroundCloseSymbol) {
      pendingSurroundSelectionRef.current = null;
      return false;
    }

    let handled = false;
    editor.update(() => {
      const selectionSnapshot =
        pendingSurroundSelection ??
        (() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) {
            return null;
          }
          if ($selectionTouchesInlineToken(selection)) {
            return null;
          }
          const range = getSelectionRangeForExpandedComposerOffsets(selection);
          if (!range || range.start === range.end) {
            return null;
          }
          const value = $getRoot().getTextContent();
          if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
            return null;
          }
          return {
            value,
            expandedStart: range.start,
            expandedEnd: range.end,
          };
        })();

      if (!selectionSnapshot || !surroundCloseSymbol) {
        return;
      }

      const selectedText = selectionSnapshot.value.slice(
        selectionSnapshot.expandedStart,
        selectionSnapshot.expandedEnd,
      );
      const nextValue = `${selectionSnapshot.value.slice(0, selectionSnapshot.expandedStart)}${inputData}${selectedText}${surroundCloseSymbol}${selectionSnapshot.value.slice(selectionSnapshot.expandedEnd)}`;
      $setComposerEditorPrompt(nextValue, terminalContextsRef.current, skillMetadataRef.current);
      const selectionStart = collapseExpandedComposerCursor(
        nextValue,
        selectionSnapshot.expandedStart,
      );
      $setSelectionRangeAtComposerOffsets(
        selectionStart + inputData.length,
        selectionStart + inputData.length + selectedText.length,
      );
      handled = true;
      pendingSurroundSelectionRef.current = null;
    });

    return handled;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pendingDeadKeySelectionRef.current) {
        if (event.key === "Dead" || event.key === " " || event.code === "Space") {
          return;
        }
        pendingDeadKeySelectionRef.current = null;
      }

      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey) {
        pendingSurroundSelectionRef.current = null;
        pendingDeadKeySelectionRef.current = null;
        return;
      }

      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        if ($selectionTouchesInlineToken(selection)) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const range = getSelectionRangeForExpandedComposerOffsets(selection);
        if (!range || range.start === range.end) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const value = $getRoot().getTextContent();
        if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const snapshot = {
          value,
          expandedStart: range.start,
          expandedEnd: range.end,
        };
        pendingSurroundSelectionRef.current = snapshot;
        pendingDeadKeySelectionRef.current = null;
      });
    };

    const onBeforeInput = (event: InputEvent) => {
      if (
        event.inputType === "insertCompositionText" &&
        event.data === "`" &&
        BACKTICK_SURROUND_CLOSE_SYMBOL !== null &&
        pendingSurroundSelectionRef.current
      ) {
        pendingDeadKeySelectionRef.current = pendingSurroundSelectionRef.current;
        return;
      }

      if (pendingDeadKeySelectionRef.current) {
        return;
      }

      if (event.inputType === "insertCompositionText") {
        return;
      }

      if (typeof event.data !== "string") {
        pendingSurroundSelectionRef.current = null;
        return;
      }
      const inputData = event.inputType === "insertText" ? event.data : null;
      if (!inputData || inputData.length !== 1) {
        pendingSurroundSelectionRef.current = null;
        return;
      }
      if (!applySurroundInsertion(inputData)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const tryApplyDeadKeyBacktickSurround = (options?: { finalAttempt?: boolean }) => {
      queueMicrotask(() => {
        editor.update(
          () => {
            const pendingDeadKeySelection = pendingDeadKeySelectionRef.current;
            if (!pendingDeadKeySelection) {
              return;
            }

            const currentValue = $getRoot().getTextContent();
            const backtickCloseSymbol = BACKTICK_SURROUND_CLOSE_SYMBOL;
            if (backtickCloseSymbol === null) {
              pendingDeadKeySelectionRef.current = null;
              return;
            }

            const expectedResolvedValue = `${pendingDeadKeySelection.value.slice(0, pendingDeadKeySelection.expandedStart)}\`${pendingDeadKeySelection.value.slice(pendingDeadKeySelection.expandedEnd)}`;
            if (currentValue !== expectedResolvedValue) {
              if (options?.finalAttempt) {
                pendingSurroundSelectionRef.current = null;
                pendingDeadKeySelectionRef.current = null;
              }
              return;
            }

            const selectedText = pendingDeadKeySelection.value.slice(
              pendingDeadKeySelection.expandedStart,
              pendingDeadKeySelection.expandedEnd,
            );
            const replacementStart = collapseExpandedComposerCursor(
              currentValue,
              pendingDeadKeySelection.expandedStart,
            );
            $setSelectionRangeAtComposerOffsets(replacementStart, replacementStart + 1);
            const replacementSelection = $getSelection();
            if (!$isRangeSelection(replacementSelection)) {
              pendingSurroundSelectionRef.current = null;
              pendingDeadKeySelectionRef.current = null;
              return;
            }
            replacementSelection.insertText(`\`${selectedText}${backtickCloseSymbol}`);
            $setSelectionRangeAtComposerOffsets(
              replacementStart + 1,
              replacementStart + 1 + selectedText.length,
            );
            pendingSurroundSelectionRef.current = null;
            pendingDeadKeySelectionRef.current = null;
          },
          { tag: HISTORY_MERGE_TAG },
        );
      });
    };

    const onInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (
        inputEvent.inputType === "insertText" ||
        inputEvent.inputType === "insertCompositionText"
      ) {
        tryApplyDeadKeyBacktickSurround();
      }
    };

    const onCompositionEnd = () => {
      tryApplyDeadKeyBacktickSurround({ finalAttempt: true });
    };

    let activeRootElement: HTMLElement | null = null;
    const unregisterRootListener = editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("keydown", onKeyDown);
      prevRootElement?.removeEventListener("beforeinput", onBeforeInput, true);
      prevRootElement?.removeEventListener("input", onInput);
      prevRootElement?.removeEventListener("compositionend", onCompositionEnd);
      rootElement?.addEventListener("keydown", onKeyDown);
      rootElement?.addEventListener("beforeinput", onBeforeInput, true);
      rootElement?.addEventListener("input", onInput);
      rootElement?.addEventListener("compositionend", onCompositionEnd);
      activeRootElement = rootElement;
    });

    return () => {
      if (activeRootElement) {
        activeRootElement.removeEventListener("keydown", onKeyDown);
        activeRootElement.removeEventListener("beforeinput", onBeforeInput, true);
        activeRootElement.removeEventListener("input", onInput);
        activeRootElement.removeEventListener("compositionend", onCompositionEnd);
      }
      unregisterRootListener();
    };
  }, [editor]);

  return null;
}

async function copyComposerDebugText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea copy path for browsers with stricter clipboard rules.
    }
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.append(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

function ComposerDebugPanel() {
  const [enabled, setEnabled] = useState(() => isComposerDebugEnabled());
  const [entryCount, setEntryCount] = useState(() => readComposerDebugEntries().length);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => {
      setEntryCount(readComposerDebugEntries().length);
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [enabled]);

  useEffect(() => {
    setEnabled(isComposerDebugEnabled());
  }, []);

  if (!enabled) {
    return null;
  }

  const copyLog = () => {
    void copyComposerDebugText(formatComposerDebugPayload()).then(
      () => {
        setEntryCount(readComposerDebugEntries().length);
        setStatus("Copied");
      },
      () => setStatus("Copy failed"),
    );
  };
  const clearLog = () => {
    clearComposerDebugEntries();
    setEntryCount(0);
    setStatus("Cleared");
  };

  return (
    <div
      className="fixed bottom-3 right-3 z-100 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-lg"
      data-composer-debug-panel="true"
    >
      <span className="whitespace-nowrap font-medium">Composer debug</span>
      <span className="whitespace-nowrap text-muted-foreground">{entryCount} events</span>
      <button
        className="rounded border border-input px-2 py-1 text-xs hover:bg-accent"
        onClick={copyLog}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        Copy
      </button>
      <button
        className="rounded border border-input px-2 py-1 text-xs hover:bg-accent"
        onClick={clearLog}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        Clear
      </button>
      {status ? <span className="whitespace-nowrap text-muted-foreground">{status}</span> : null}
    </div>
  );
}

function ComposerPromptEditorInner({
  value,
  cursor,
  terminalContexts,
  skills,
  disabled,
  placeholder,
  className,
  onRemoveTerminalContext,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const terminalContextsSignature = terminalContextSignature(terminalContexts);
  const terminalContextsSignatureRef = useRef(terminalContextsSignature);
  const skillsSignature = skillSignature(skills);
  const skillsSignatureRef = useRef(skillsSignature);
  const skillMetadataRef = useRef(skillMetadataByName(skills));
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
    terminalContextIds: terminalContexts.map((context) => context.id),
  });
  const nativeInputTrackerRef = useRef(createComposerNativeInputTracker());
  const isApplyingControlledUpdateRef = useRef(false);
  const terminalContextActions = useMemo(
    () => ({ onRemoveTerminalContext }),
    [onRemoveTerminalContext],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useLayoutEffect(() => {
    skillMetadataRef.current = skillMetadataByName(skills);
  }, [skills]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    const contextsChanged = terminalContextsSignatureRef.current !== terminalContextsSignature;
    const skillsChanged = skillsSignatureRef.current !== skillsSignature;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      !contextsChanged &&
      !skillsChanged
    ) {
      appendComposerDebugEvent("controlledSync.skip.sameSnapshot", {
        cursor: normalizedCursor,
        valueLength: value.length,
        valueTail: composerDebugTextTail(value),
      });
      return;
    }

    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor),
      terminalContextIds: terminalContexts.map((context) => context.id),
    };
    terminalContextsSignatureRef.current = terminalContextsSignature;
    skillsSignatureRef.current = skillsSignature;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !contextsChanged && !skillsChanged && !isFocused) {
      appendComposerDebugEvent("controlledSync.skip.unfocusedCursorOnly", {
        previousCursor: previousSnapshot.cursor,
        nextCursor: normalizedCursor,
        valueLength: value.length,
        valueTail: composerDebugTextTail(value),
      });
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    appendComposerDebugEvent("controlledSync.apply", {
      focused: isFocused,
      shouldRewriteEditorState:
        previousSnapshot.value !== value || contextsChanged || skillsChanged,
      previous: {
        valueLength: previousSnapshot.value.length,
        valueTail: composerDebugTextTail(previousSnapshot.value),
        cursor: previousSnapshot.cursor,
        expandedCursor: previousSnapshot.expandedCursor,
      },
      next: {
        valueLength: value.length,
        valueTail: composerDebugTextTail(value),
        cursor: normalizedCursor,
        expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor),
      },
      contextsChanged,
      skillsChanged,
      editorSnapshot: readComposerDebugEditorSnapshot(editor, previousSnapshot.cursor),
    });
    editor.update(() => {
      const shouldRewriteEditorState =
        previousSnapshot.value !== value || contextsChanged || skillsChanged;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value, terminalContexts, skillMetadataRef.current);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(normalizedCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, editor, skillsSignature, terminalContexts, terminalContextsSignature, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      appendComposerDebugEvent("imperative.focusAt", {
        requestedCursor: nextCursor,
        boundedCursor,
        before: {
          valueLength: snapshotRef.current.value.length,
          valueTail: composerDebugTextTail(snapshotRef.current.value),
          cursor: snapshotRef.current.cursor,
          expandedCursor: snapshotRef.current.expandedCursor,
        },
        editorSnapshot: readComposerDebugEditorSnapshot(editor, snapshotRef.current.cursor),
      });
      rootElement.focus({ preventScroll: true });
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        terminalContextIds: snapshotRef.current.terminalContextIds,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.terminalContextIds,
        readComposerNativeInputChangeMetadata(nativeInputTrackerRef.current),
      );
    },
    [editor],
  );

  const readSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [editor]);

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
      readSnapshot,
    }),
    [focusAt, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor &&
        previousSnapshot.terminalContextIds.length === terminalContextIds.length &&
        previousSnapshot.terminalContextIds.every((id, index) => id === terminalContextIds[index])
      ) {
        appendComposerDebugEvent("lexicalChange.skip.sameSnapshot", {
          cursor: nextCursor,
          expandedCursor: nextExpandedCursor,
          valueLength: nextValue.length,
          valueTail: composerDebugTextTail(nextValue),
        });
        return;
      }
      if (isApplyingControlledUpdateRef.current) {
        appendComposerDebugEvent("lexicalChange.skip.controlledUpdate", {
          cursor: nextCursor,
          expandedCursor: nextExpandedCursor,
          valueLength: nextValue.length,
          valueTail: composerDebugTextTail(nextValue),
        });
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      appendComposerDebugEvent("lexicalChange.emit", {
        previous: {
          valueLength: previousSnapshot.value.length,
          valueTail: composerDebugTextTail(previousSnapshot.value),
          cursor: previousSnapshot.cursor,
          expandedCursor: previousSnapshot.expandedCursor,
        },
        next: {
          valueLength: nextValue.length,
          valueTail: composerDebugTextTail(nextValue),
          cursor: nextCursor,
          expandedCursor: nextExpandedCursor,
        },
        cursorAdjacentToMention,
        terminalContextIds,
        metadata: readComposerNativeInputChangeMetadata(nativeInputTrackerRef.current),
      });
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextExpandedCursor,
        cursorAdjacentToMention,
        terminalContextIds,
        readComposerNativeInputChangeMetadata(nativeInputTrackerRef.current),
      );
    });
  }, []);

  return (
    <ComposerTerminalContextActionsContext value={terminalContextActions}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "block max-h-50 min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent text-[16px] leading-relaxed text-foreground focus:outline-none sm:text-[14px]",
                className,
              )}
              data-testid="composer-editor"
              ariaMultiline
              aria-placeholder={placeholder}
              autoCapitalize="sentences"
              autoCorrect="on"
              inputMode="text"
              placeholder={<span />}
              onPaste={onPaste}
              spellCheck
            />
          }
          placeholder={
            terminalContexts.length > 0 ? null : (
              <div className="pointer-events-none absolute inset-0 text-[16px] leading-relaxed text-muted-foreground/35 sm:text-[14px]">
                {placeholder}
              </div>
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
        <ComposerSurroundSelectionPlugin terminalContexts={terminalContexts} skills={skills} />
        <ComposerNativeInputPlugin nativeInputTrackerRef={nativeInputTrackerRef} />
        <ComposerInlineTokenArrowPlugin />
        <ComposerInlineTokenSelectionNormalizePlugin />
        <ComposerInlineTokenBackspacePlugin />
        <HistoryPlugin />
        <ComposerDebugPanel />
      </div>
    </ComposerTerminalContextActionsContext>
  );
}

export function ComposerPromptEditor({
  value,
  cursor,
  terminalContexts,
  skills,
  disabled,
  placeholder,
  className,
  onRemoveTerminalContext,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorProps) {
  const initialValueRef = useRef(value);
  const initialTerminalContextsRef = useRef(terminalContexts);
  const initialSkillMetadataRef = useRef(skillMetadataByName(skills));
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "t3tools-composer-editor",
      editable: true,
      nodes: [ComposerMentionNode, ComposerSkillNode, ComposerTerminalContextNode],
      editorState: () => {
        $setComposerEditorPrompt(
          initialValueRef.current,
          initialTerminalContextsRef.current,
          initialSkillMetadataRef.current,
        );
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        terminalContexts={terminalContexts}
        skills={skills}
        disabled={disabled}
        placeholder={placeholder}
        onRemoveTerminalContext={onRemoveTerminalContext}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={editorRef}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
      />
    </LexicalComposer>
  );
}
