import type { ComposerInlineItem } from "@t3tools/contracts";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $applyNodeReplacement,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  TextNode,
  type EditorConfig,
  type EditorState,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEventHandler,
  type Ref,
} from "react";

import { isCollapsedCursorAdjacentToMention } from "~/composer-logic";
import {
  inlineItemDisplayText,
  normalizeComposerInlineItems,
  splitPromptIntoComposerSegments,
} from "~/composer-editor-mentions";
import {
  getComposerInlineItemChipLabelClassName,
  getComposerInlineItemChipLabelText,
} from "~/composer-inline-item-display";
import { cn } from "~/lib/utils";
import { basenameOfPath, getVscodeIconUrlForEntry } from "~/vscode-icons";
import { shouldRemoveCurrentInlineItemOnBackspace } from "./composerInlineItemEditor.logic";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;

type SerializedComposerInlineItemNode = Spread<
  {
    inlineItem: Pick<ComposerInlineItem, "kind" | "name" | "path">;
    type: "composer-inline-item";
    version: 1;
  },
  SerializedTextNode
>;

class ComposerInlineItemNode extends TextNode {
  __inlineItem: Pick<ComposerInlineItem, "kind" | "name" | "path">;

  static override getType(): string {
    return "composer-inline-item";
  }

  static override clone(node: ComposerInlineItemNode): ComposerInlineItemNode {
    return new ComposerInlineItemNode(node.__inlineItem, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerInlineItemNode,
  ): ComposerInlineItemNode {
    return $createComposerInlineItemNode(serializedNode.inlineItem);
  }

  constructor(inlineItem: Pick<ComposerInlineItem, "kind" | "name" | "path">, key?: NodeKey) {
    super(inlineItemDisplayText(inlineItem), key);
    this.__inlineItem = { ...inlineItem };
  }

  override exportJSON(): SerializedComposerInlineItemNode {
    return {
      ...super.exportJSON(),
      inlineItem: this.__inlineItem,
      type: "composer-inline-item",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className =
      "inline-flex select-none items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-px font-medium text-[12px] leading-[1.1] text-foreground align-middle";
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderInlineItemChipDom(dom, this.__inlineItem);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerInlineItemNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (
      prevNode.__text !== this.__text ||
      prevNode.__inlineItem.kind !== this.__inlineItem.kind ||
      prevNode.__inlineItem.name !== this.__inlineItem.name ||
      prevNode.__inlineItem.path !== this.__inlineItem.path
    ) {
      renderInlineItemChipDom(dom, this.__inlineItem);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerInlineItemNode(
  inlineItem: Pick<ComposerInlineItem, "kind" | "name" | "path">,
): ComposerInlineItemNode {
  return $applyNodeReplacement(new ComposerInlineItemNode(inlineItem));
}

function inferMentionPathKind(pathValue: string): "file" | "directory" {
  const base = basenameOfPath(pathValue);
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return "directory";
  }
  if (base.includes(".")) {
    return "file";
  }
  return "directory";
}

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function renderInlineItemChipDom(
  container: HTMLElement,
  inlineItem: Pick<ComposerInlineItem, "kind" | "name" | "path">,
): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  if (inlineItem.kind === "skill") {
    container.className =
      "inline-flex max-w-full min-w-0 select-none items-center rounded-md border border-border/70 bg-accent/40 px-1.5 py-px font-medium text-[12px] leading-[1.1] text-foreground align-middle";
    const label = document.createElement("span");
    label.className = getComposerInlineItemChipLabelClassName(inlineItem);
    label.textContent = getComposerInlineItemChipLabelText(inlineItem);
    container.append(label);
    return;
  }

  container.className =
    "inline-flex max-w-full min-w-0 select-none items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-px font-medium text-[12px] leading-[1.1] text-foreground align-middle";

  const theme = resolvedThemeFromDocument();
  const icon = document.createElement("img");
  icon.alt = "";
  icon.ariaHidden = "true";
  icon.className = "size-3.5 shrink-0 opacity-85";
  icon.loading = "lazy";
  icon.src = getVscodeIconUrlForEntry(
    inlineItem.path,
    inferMentionPathKind(inlineItem.path),
    theme,
  );

  const label = document.createElement("span");
  label.className = getComposerInlineItemChipLabelClassName(inlineItem);
  label.textContent = getComposerInlineItemChipLabelText(inlineItem);

  container.append(icon, label);
}

function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}

function inlineItemsEqual(
  left: ReadonlyArray<ComposerInlineItem>,
  right: ReadonlyArray<ComposerInlineItem>,
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      !leftItem ||
      !rightItem ||
      leftItem.kind !== rightItem.kind ||
      leftItem.name !== rightItem.name ||
      leftItem.path !== rightItem.path ||
      leftItem.start !== rightItem.start ||
      leftItem.end !== rightItem.end
    ) {
      return false;
    }
  }
  return true;
}

function getComposerNodeTextLength(node: LexicalNode): number {
  if (node instanceof ComposerInlineItemNode) {
    return 1;
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
    if (node instanceof ComposerInlineItemNode) {
      return offset + (pointOffset > 0 ? 1 : 0);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
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

function findSelectionPointAtOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if (node instanceof ComposerInlineItemNode) {
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
  const point =
    findSelectionPointAtOffset(root, remainingRef) ?? {
      key: root.getKey(),
      offset: root.getChildren().length,
      type: "element" as const,
    };
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
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
  inlineItems: ReadonlyArray<ComposerInlineItem> | undefined,
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const segments = splitPromptIntoComposerSegments(prompt, inlineItems);
  for (const segment of segments) {
    if (segment.type === "inline-item") {
      paragraph.append($createComposerInlineItemNode(segment.inlineItem));
      continue;
    }
    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

function $collectComposerInlineItems(): ComposerInlineItem[] {
  const items: ComposerInlineItem[] = [];
  const visit = (node: LexicalNode, visibleOffsetRef: { value: number }) => {
    if (node instanceof ComposerInlineItemNode) {
      const displayText = node.getTextContent();
      const start = visibleOffsetRef.value;
      const end = start + displayText.length;
      items.push({
        kind: node.__inlineItem.kind,
        name: node.__inlineItem.name,
        path: node.__inlineItem.path,
        start,
        end,
      });
      visibleOffsetRef.value = end;
      return;
    }
    if ($isTextNode(node)) {
      visibleOffsetRef.value += node.getTextContentSize();
      return;
    }
    if ($isLineBreakNode(node)) {
      visibleOffsetRef.value += 1;
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child, visibleOffsetRef);
      }
    }
  };

  const visibleOffsetRef = { value: 0 };
  for (const child of $getRoot().getChildren()) {
    visit(child, visibleOffsetRef);
  }
  return items;
}

export interface ComposerPromptEditorSnapshot {
  value: string;
  cursor: number;
  inlineItems: ComposerInlineItem[];
}

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSnapshot: () => ComposerPromptEditorSnapshot;
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  inlineItems: ReadonlyArray<ComposerInlineItem>;
  disabled: boolean;
  placeholder: string;
  className?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    nextInlineItems: ComposerInlineItem[],
    cursorAdjacentToInlineItem: boolean,
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: ClipboardEventHandler<HTMLElement>;
}

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
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

function ComposerInlineItemArrowPlugin(props: {
  getInlineItems: () => ReadonlyArray<ComposerInlineItem>;
}) {
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
          if (
            !isCollapsedCursorAdjacentToMention(
              promptValue,
              props.getInlineItems(),
              currentOffset,
              "left",
            )
          ) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(nextOffset!);
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
          if (
            !isCollapsedCursorAdjacentToMention(
              promptValue,
              props.getInlineItems(),
              currentOffset,
              "right",
            )
          ) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(nextOffset!);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor, props]);

  return null;
}

function ComposerInlineItemSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!(anchorNode instanceof ComposerInlineItemNode)) return;
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

function ComposerInlineItemBackspacePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const removeInlineItemNode = (candidate: unknown): boolean => {
          if (!(candidate instanceof ComposerInlineItemNode)) {
            return false;
          }
          const inlineItemStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          $setSelectionAtComposerOffset(inlineItemStart);
          event?.preventDefault();
          return true;
        };

        if (
          anchorNode instanceof ComposerInlineItemNode &&
          shouldRemoveCurrentInlineItemOnBackspace(selection.anchor.offset) &&
          removeInlineItemNode(anchorNode)
        ) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineItemNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineItemNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineItemNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

function ComposerPromptEditorInner({
  value,
  cursor,
  inlineItems,
  disabled,
  placeholder,
  className,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const snapshotRef = useRef<ComposerPromptEditorSnapshot>({
    value,
    cursor: clampCursor(value, cursor),
    inlineItems: normalizeComposerInlineItems(value, inlineItems),
  });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCursor(value, cursor);
    const normalizedInlineItems = normalizeComposerInlineItems(value, inlineItems);
    const previousSnapshot = snapshotRef.current;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      inlineItemsEqual(previousSnapshot.inlineItems, normalizedInlineItems)
    ) {
      return;
    }

    if (
      previousSnapshot.value !== value ||
      !inlineItemsEqual(previousSnapshot.inlineItems, normalizedInlineItems)
    ) {
      editor.update(() => {
        $setComposerEditorPrompt(value, normalizedInlineItems);
      });
    }

    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      inlineItems: normalizedInlineItems,
    };

    const rootElement = editor.getRootElement();
    if (!rootElement || document.activeElement !== rootElement) {
      return;
    }

    editor.update(() => {
      $setSelectionAtComposerOffset(normalizedCursor);
    });
  }, [cursor, editor, inlineItems, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        ...snapshotRef.current,
        cursor: boundedCursor,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.inlineItems,
        false,
      );
    },
    [editor],
  );

  const readSnapshot = useCallback((): ComposerPromptEditorSnapshot => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const nextValue = $getRoot().getTextContent();
      const nextInlineItems = $collectComposerInlineItems();
      const fallbackCursor = clampCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        inlineItems: nextInlineItems,
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
      focusAt: (nextCursor: number) => {
        focusAt(nextCursor);
      },
      focusAtEnd: () => {
        focusAt(snapshotRef.current.value.length);
      },
      readSnapshot,
    }),
    [focusAt, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      const nextInlineItems = $collectComposerInlineItems();
      const fallbackCursor = clampCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCursor(nextValue, $readSelectionOffsetFromEditorState(fallbackCursor));
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        inlineItemsEqual(previousSnapshot.inlineItems, nextInlineItems)
      ) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        inlineItems: nextInlineItems,
      };
      const cursorAdjacentToInlineItem =
        isCollapsedCursorAdjacentToMention(nextValue, nextInlineItems, nextCursor, "left") ||
        isCollapsedCursorAdjacentToMention(nextValue, nextInlineItems, nextCursor, "right");
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextInlineItems,
        cursorAdjacentToInlineItem,
      );
    });
  }, []);

  return (
    <div className="relative">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className={cn(
              "block max-h-[200px] min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[14px] leading-relaxed text-foreground focus:outline-none",
              className,
            )}
            aria-placeholder={placeholder}
            placeholder={<span />}
            onPaste={onPaste}
          />
        }
        placeholder={
          <div className="pointer-events-none absolute inset-0 text-[14px] leading-relaxed text-muted-foreground/35">
            {placeholder}
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={handleEditorChange} />
      <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
      <ComposerInlineItemArrowPlugin getInlineItems={() => snapshotRef.current.inlineItems} />
      <ComposerInlineItemSelectionNormalizePlugin />
      <ComposerInlineItemBackspacePlugin />
      <HistoryPlugin />
    </div>
  );
}

export const ComposerPromptEditor = forwardRef<ComposerPromptEditorHandle, ComposerPromptEditorProps>(
  function ComposerPromptEditor(
    { value, cursor, inlineItems, disabled, placeholder, className, onChange, onCommandKeyDown, onPaste },
    ref,
  ) {
    const initialValueRef = useRef(value);
    const initialInlineItemsRef = useRef(normalizeComposerInlineItems(value, inlineItems));
    const initialConfig = useMemo<InitialConfigType>(
      () => ({
        namespace: "t3tools-composer-editor",
        editable: true,
        nodes: [ComposerInlineItemNode],
        editorState: () => {
          $setComposerEditorPrompt(initialValueRef.current, initialInlineItemsRef.current);
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
          inlineItems={inlineItems}
          disabled={disabled}
          placeholder={placeholder}
          onChange={onChange}
          onPaste={onPaste}
          editorRef={ref}
          {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
          {...(className ? { className } : {})}
        />
      </LexicalComposer>
    );
  },
);
