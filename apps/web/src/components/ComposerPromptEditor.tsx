import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptap";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

/**
 * The composer editor. Tiptap in both modes: the `richTextEnabled` setting
 * toggles Markdown styling, never the engine. Plain mode renders every
 * marker as a literal character and serializes byte-identically.
 */
function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const collapsedRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const collapsedRect = edge === "start" ? collapsedRects.at(-1) : collapsedRects[0];
  if (collapsedRect) return collapsedRect;

  const container = range.startContainer;
  if (container.nodeType === Node.TEXT_NODE) {
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
  // The caret sits between the paragraph's children, which is where Lexical
  // puts it next to an inline chip. Measure the neighbouring child.
  const neighbour =
    container.childNodes[Math.max(0, range.startOffset - 1)] ??
    container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    // Probe the character on the caret's side. A soft-wrapped text node's
    // first rect is its first visual line, which may not be the caret's.
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

      if (key === "Enter" && (event.isComposing || event.keyCode === 229)) {
        event.stopPropagation();
        return true;
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

function ComposerHomeEndKeyPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!isMacPlatform(navigator.platform)) {
          return false;
        }
        if (event.key !== "Home" && event.key !== "End") {
          return false;
        }
        if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return false;
        }

        const rootElement = editor.getRootElement();
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        if (!rootElement || !selection || !anchorNode || !rootElement.contains(anchorNode)) {
          return false;
        }
        if (selection.rangeCount === 0 || typeof selection.modify !== "function") {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();

        selection.modify(
          event.shiftKey ? "extend" : "move",
          event.key === "Home" ? "backward" : "forward",
          "lineboundary",
        );
        editor.update(() => {
          $setSelection($createRangeSelectionFromDom(selection, editor));
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
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

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          $setSelectionAtComposerOffset(tokenStart);
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
  }, [editor]);

  return null;
}

/**
 * Chips render as non-editable decorators, so the browser never paints the
 * native text selection over them; without help, a selection spanning chips
 * is only visible in the slivers between them. Mirror the selection onto the
 * chips with a data attribute the stylesheet turns into a highlight overlay.
 */
function ComposerChipSelectionPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let selectedKeys = new Set<string>();
    // Lexical keeps the range selection on blur without emitting an update,
    // so focus is tracked separately; while blurred the native highlight is
    // gone and the mirrored one has to go with it.
    let hasFocus = editor.getRootElement() === document.activeElement;

    const applyKeys = (nextKeys: Set<string>) => {
      for (const key of selectedKeys) {
        if (!nextKeys.has(key)) {
          editor.getElementByKey(key)?.removeAttribute("data-composer-chip-selected");
        }
      }
      for (const key of nextKeys) {
        editor.getElementByKey(key)?.setAttribute("data-composer-chip-selected", "true");
      }
      selectedKeys = nextKeys;
    };

    const readSelectedKeys = () => {
      const nextKeys = new Set<string>();
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          for (const node of selection.getNodes()) {
            if (node instanceof DecoratorNode) {
              nextKeys.add(node.getKey());
            }
          }
        }
      });
      return nextKeys;
    };

    const unregisterUpdate = editor.registerUpdateListener(() => {
      applyKeys(hasFocus ? readSelectedKeys() : new Set());
    });
    const unregisterFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        hasFocus = true;
        applyKeys(readSelectedKeys());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        hasFocus = false;
        applyKeys(new Set());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      unregisterUpdate();
      unregisterFocus();
      unregisterBlur();
    };
  }, [editor]);

  return null;
}

function ComposerInlineTokenPastePlugin(props: {
  importContextFragment?: ComposerPromptEditorProps["importContextFragment"];
}) {
  const [editor] = useLexicalComposerContext();
  const importContextFragment = props.importContextFragment;

  useEffect(
    () =>
      registerComposerInlineTokenPaste(editor, {
        createMentionNode: $createComposerMentionNode,
        createCitationNode: $createComposerCitationNode,
        createContextReferenceNode: $createComposerContextReferenceNode,
        getExpandedAbsoluteOffsetForPoint,
        ...(importContextFragment ? { importContextFragment } : {}),
      }),
    [editor, importContextFragment],
  );

  return null;
}

/**
 * Copying chips must carry their payloads: the default copy writes the canonical links as
 * text, and this adds the structured fragment for the referenced records beside it.
 */
function ComposerContextClipboardPlugin(props: {
  buildContextClipboardFragment?: ComposerPromptEditorProps["buildContextClipboardFragment"];
}) {
  const [editor] = useLexicalComposerContext();
  const build = props.buildContextClipboardFragment;

  useEffect(() => {
    if (!build) return;
    const listener = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean) => {
      if (!event || !("clipboardData" in event) || !event.clipboardData) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
      const text = selection.getTextContent();
      const contextIds = collectInlineContextIds(text);
      if (contextIds.length === 0) return false;
      const fragment = build(contextIds);
      if (!fragment) return false;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      event.clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
      event.clipboardData.setData("text/html", encodeComposerContextClipboardHtml(text, fragment));
      if (cut) selection.removeText();
      return true;
    };
    const unregisterCopy = editor.registerCommand(
      COPY_COMMAND,
      (event) => listener(event, false),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterCut = editor.registerCommand(
      CUT_COMMAND,
      (event) => listener(event, true),
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterCopy();
      unregisterCut();
    };
  }, [build, editor]);

  return null;
}

function ComposerSurroundSelectionPlugin(props: { skills: ReadonlyArray<ServerProviderSkill> }) {
  const [editor] = useLexicalComposerContext();
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
      $setComposerEditorPrompt(nextValue, skillMetadataRef.current);
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

function ComposerPromptEditorInner({
  value,
  cursor,
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
}: ComposerPromptEditorProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const onVisibleSelectionChangeRef = useRef(onVisibleSelectionChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const initialExpandedCursor = expandCollapsedComposerCursor(value, initialCursor);
  const skillsSignature = skillSignature(skills);
  const skillsSignatureRef = useRef(skillsSignature);
  const skillMetadataRef = useRef(skillMetadataByName(skills));
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: initialExpandedCursor,
    contextIds: collectInlineContextIds(value),
  });
  const selectionRangeRef = useRef({ start: initialExpandedCursor, end: initialExpandedCursor });
  const isApplyingControlledUpdateRef = useRef(false);
  // Latest controlled value, readable from editor listeners that fire before the layout
  // effect has rewritten the editor to match it.
  const latestValueRef = useRef(value);
  useLayoutEffect(() => {
    latestValueRef.current = value;
  }, [value]);
  const citationCommentRequestRef = useRef<ComposerCitationCommentRequest | null>(null);
  const [openCitationComment, setOpenCitationComment] =
    useState<ComposerCitationCommentTarget | null>(null);
  const citationCommentActions = useMemo(
    () => ({
      openComment: openCitationComment,
      onOpenChange: (nodeKey: NodeKey, open: boolean) => {
        setOpenCitationComment((current) =>
          open ? { nodeKey } : current?.nodeKey === nodeKey ? null : current,
        );
      },
      onSubmitAndSend: onCitationSubmitAndSend ?? (() => {}),
    }),
    [onCitationSubmitAndSend, openCitationComment],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onVisibleSelectionChangeRef.current = onVisibleSelectionChange;
  }, [onVisibleSelectionChange]);

  useLayoutEffect(() => {
    skillMetadataRef.current = skillMetadataByName(skills);
  }, [skills]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    const openCitationNodeKey = openCitationComment?.nodeKey;
    if (!openCitationNodeKey) return;
    return editor.registerUpdateListener(({ editorState }) => {
      const isAttached = editorState.read(() => {
        const node = $getNodeByKey(openCitationNodeKey);
        return node instanceof ComposerCitationNode && node.isAttached();
      });
      if (!isAttached) {
        setOpenCitationComment((current) =>
          current?.nodeKey === openCitationNodeKey ? null : current,
        );
      }
    });
  }, [editor, openCitationComment?.nodeKey]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    const skillsChanged = skillsSignatureRef.current !== skillsSignature;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      !skillsChanged
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
    skillsSignatureRef.current = skillsSignature;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !skillsChanged && !isFocused) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    const isCiteInsertion = citationCommentRequestRef.current?.value === value;
    let citationToOpen: ComposerCitationCommentTarget | null = null;
    editor.update(
      () => {
        const shouldRewriteEditorState = previousSnapshot.value !== value || skillsChanged;
        if (shouldRewriteEditorState) {
          $setComposerEditorPrompt(value, skillMetadataRef.current);
        }
        if (shouldRewriteEditorState || isFocused) {
          $setSelectionAtComposerOffset(normalizedCursor);
        }
        citationToOpen = $consumeComposerCitationCommentRequest(citationCommentRequestRef);
      },
      {
        ...(isCiteInsertion ? { tag: [HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG] } : {}),
        onUpdate: () => {
          if (citationToOpen) setOpenCitationComment(citationToOpen);
        },
      },
    );
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, editor, skillsSignature, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      rootElement.focus({ preventScroll: true });
      // A newer prompt is waiting to be applied (a chip was just inserted through the store).
      // Reporting the editor's stale text now would overwrite that prompt; the pending rewrite
      // places the caret from the store's cursor instead.
      if (snapshotRef.current.value !== latestValueRef.current) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
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

  const readSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
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
      const selectionRange = getSelectionRangeForExpandedComposerOffsets($getSelection());
      const contextIds = collectContextIds($getRoot());
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        contextIds,
      };
      selectionRangeRef.current = selectionRange ?? {
        start: nextExpandedCursor,
        end: nextExpandedCursor,
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
      readSelectionRange: () => {
        readSnapshot();
        return selectionRangeRef.current;
      },
      requestCitationComment: (request) => {
        citationCommentRequestRef.current = request;
        const target = editor
          .getEditorState()
          .read(() => $consumeComposerCitationCommentRequest(citationCommentRequestRef));
        if (target) setOpenCitationComment(target);
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
        const rootElement = editor.getRootElement();
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
      const nextSelectionRange = getSelectionRangeForExpandedComposerOffsets($getSelection());
      const previousSelectionRange = selectionRangeRef.current;
      selectionRangeRef.current = nextSelectionRange ?? {
        start: nextExpandedCursor,
        end: nextExpandedCursor,
      };
      const contextIds = collectContextIds($getRoot());
      const previousSnapshot = snapshotRef.current;
      const snapshotChanged = !(
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor &&
        previousSnapshot.contextIds.length === contextIds.length &&
        previousSnapshot.contextIds.every((id, index) => id === contextIds[index])
      );
      if (isApplyingControlledUpdateRef.current) {
        return;
      }
      if (!snapshotChanged) {
        if (didComposerSelectionChangeVisibly(previousSelectionRange, nextSelectionRange)) {
          onVisibleSelectionChangeRef.current?.();
        }
        return;
      }
      // A selection-only update while a newer prompt waits to be applied (an attachment
      // chip was just inserted through the store) would report stale text and stale
      // context ids, clobbering the prompt and dropping the record. Let the rewrite land.
      if (previousSnapshot.value === nextValue && nextValue !== latestValueRef.current) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        contextIds,
      };
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextExpandedCursor,
        cursorAdjacentToMention,
        contextIds,
      );
    });
  }, []);

  return (
    <ComposerContextRecordsContext value={contextRecords}>
      <ComposerCitationCommentContext value={citationCommentActions}>
        <div
          data-composer-prompt-surface="true"
          className={cn(
            "relative [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] [@media(max-width:39.999rem)_and_(pointer:coarse)]:[font-size:max(var(--font-size-prompt,1rem),16px)]",
            containerClassName,
          )}
        >
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className={cn(
                  // The wrapper owns the appearance preference; keep everything else here.
                  "block max-h-50 min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
                  className,
                )}
                data-testid="composer-editor"
                aria-placeholder={placeholder}
                placeholder={<span />}
                onKeyDown={(event) => {
                  if (
                    event.key === "Control" ||
                    event.key === "Meta" ||
                    event.key === "Alt" ||
                    event.key === "Shift"
                  ) {
                    onPageScrollRelease?.();
                  }

                  if (event.key !== "PageUp" && event.key !== "PageDown") {
                    return;
                  }

                  const pageScrollKey = getTimelinePageScrollKey({
                    altKey: event.altKey,
                    clientHeight: event.currentTarget.clientHeight,
                    ctrlKey: event.ctrlKey,
                    defaultPrevented: event.defaultPrevented,
                    isComposing: event.nativeEvent.isComposing,
                    key: event.key,
                    keyCode: event.keyCode,
                    metaKey: event.metaKey,
                    scrollHeight: event.currentTarget.scrollHeight,
                    scrollTop: event.currentTarget.scrollTop,
                    shiftKey: event.shiftKey,
                  });
                  if (!pageScrollKey) {
                    onPageScrollRelease?.();
                    return;
                  }
                  if (!onPageScrollKeyDown) {
                    return;
                  }

                  event.preventDefault();
                  onPageScrollKeyDown(pageScrollKey);
                }}
                onKeyUp={(event) => onPageScrollKeyUp?.(event.key)}
                onBlur={onPageScrollRelease}
                onPasteCapture={onPaste}
              />
            }
            placeholder={
              contextRecords.size > 0 ? null : (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75",
                    placeholderClassName,
                  )}
                >
                  {placeholder}
                </div>
              )
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <OnChangePlugin onChange={handleEditorChange} />
          <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
          <ComposerSurroundSelectionPlugin skills={skills} />
          <ComposerHomeEndKeyPlugin />
          <ComposerInlineTokenArrowPlugin />
          <ComposerInlineTokenSelectionNormalizePlugin />
          <ComposerInlineTokenBackspacePlugin />
          <ComposerInlineTokenPastePlugin importContextFragment={importContextFragment} />
          <ComposerContextClipboardPlugin
            buildContextClipboardFragment={buildContextClipboardFragment}
          />
          <ComposerChipSelectionPlugin />
          <HistoryPlugin />
        </div>
      </ComposerCitationCommentContext>
    </ComposerContextRecordsContext>
  );
}

export function ComposerPromptEditor({
  value,
  cursor,
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
}: ComposerPromptEditorProps) {
  const initialValueRef = useRef(value);
  const initialSkillMetadataRef = useRef(skillMetadataByName(skills));
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "t3tools-composer-editor",
      editable: true,
      nodes: [
        ComposerMentionNode,
        ComposerSkillNode,
        ComposerCitationNode,
        ComposerContextReferenceNode,
      ],
      editorState: () => {
        $setComposerEditorPrompt(initialValueRef.current, initialSkillMetadataRef.current);
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <ComposerSkillsContext value={skills}>
      <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
        <ComposerPromptEditorInner
          value={value}
          cursor={cursor}
          contextRecords={contextRecords}
          buildContextClipboardFragment={buildContextClipboardFragment}
          importContextFragment={importContextFragment}
          skills={skills}
          disabled={disabled}
          placeholder={placeholder}
          {...(containerClassName ? { containerClassName } : {})}
          onChange={onChange}
          {...(onVisibleSelectionChange ? { onVisibleSelectionChange } : {})}
          onPaste={onPaste}
          {...(onCitationSubmitAndSend ? { onCitationSubmitAndSend } : {})}
          editorRef={editorRef}
          {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
          {...(onPageScrollKeyDown ? { onPageScrollKeyDown } : {})}
          {...(onPageScrollKeyUp ? { onPageScrollKeyUp } : {})}
          {...(onPageScrollRelease ? { onPageScrollRelease } : {})}
          {...(className ? { className } : {})}
          {...(placeholderClassName ? { placeholderClassName } : {})}
        />
      </LexicalComposer>
    </ComposerSkillsContext>
  );
}
