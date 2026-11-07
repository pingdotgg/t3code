import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { isMacPlatform } from "../../lib/utils";
import { DraftId } from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";

function setup(
  prompt: string,
  composerRichTextEnabled: boolean,
  sendShortcut: "enter" | "mod-enter" = "enter",
) {
  const applyPromptReplacement = vi.fn(() => true);
  const submitComposer = vi.fn();
  const toggleInteractionMode = vi.fn();
  const input: Parameters<typeof composerCommandKeyHandler>[0] = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut,
    composerRichTextEnabled,
    routeKind: "draft",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: true,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryEntries: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("draft"),
    promptRef: { current: prompt },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: {
      current: {
        focus: vi.fn(),
        focusAt: vi.fn(),
        focusAtEnd: vi.fn(),
        readSelectionRange: () => ({ start: prompt.length, end: prompt.length }),
        requestCitationComment: vi.fn(),
        readSnapshot: () => ({
          value: prompt,
          cursor: prompt.length,
          expandedCursor: prompt.length,
          contextIds: [],
        }),
        isCaretOnVisualEdge: () => false,
      },
    },
    composerMenuOpenRef: { current: false },
    composerMenuItemsRef: { current: [] },
    activeComposerMenuItemRef: { current: null },
    setComposerDraftPrompt: vi.fn(),
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    dismissComposerTrigger: vi.fn(),
    toggleInteractionMode,
    nudgeComposerMenuHighlight: vi.fn(),
    onSelectComposerItem: vi.fn(),
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: prompt }),
    applyPromptReplacement,
    submitComposer,
  };
  return {
    onKey: composerCommandKeyHandler(input),
    applyPromptReplacement,
    submitComposer,
    toggleInteractionMode,
  };
}

function keyEvent(key: string, shiftKey = false, ctrlKey = false) {
  const mac = isMacPlatform(navigator.platform);
  return {
    key,
    shiftKey,
    ctrlKey: ctrlKey && !mac,
    metaKey: ctrlKey && mac,
    altKey: false,
  } as KeyboardEvent;
}

describe.each([false, true])("composer keys (rich text: %s)", (richText) => {
  it.each([
    { prompt: "1. item", key: "Enter", shift: true, replacement: "\n2. " },
    { prompt: "- item", key: "Enter", shift: true, replacement: "\n- " },
    { prompt: "- [x] item", key: "Enter", shift: true, replacement: "\n- [ ] " },
    { prompt: "1. item", key: "Tab", shift: false, replacement: "  " },
    { prompt: "  1. item", key: "Tab", shift: true, replacement: "" },
  ])("respects formatting for $key on $prompt", ({ prompt, key, shift, replacement }) => {
    const { onKey, applyPromptReplacement, submitComposer, toggleInteractionMode } = setup(
      prompt,
      richText,
    );
    expect(onKey(key, keyEvent(key, shift))).toBe(richText || (key === "Tab" && shift));
    if (richText) {
      expect(applyPromptReplacement).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        replacement,
        expect.any(Object),
      );
    } else {
      expect(applyPromptReplacement).not.toHaveBeenCalled();
    }
    expect(toggleInteractionMode).toHaveBeenCalledTimes(
      !richText && key === "Tab" && shift ? 1 : 0,
    );
    expect(submitComposer).not.toHaveBeenCalled();
  });

  it("uses the configured send shortcut before list continuation", () => {
    const { onKey, submitComposer, applyPromptReplacement } = setup("1. item", richText);
    expect(onKey("Enter", keyEvent("Enter"))).toBe(true);
    expect(submitComposer).toHaveBeenCalledWith(undefined, "auto", "foreground");
    expect(applyPromptReplacement).not.toHaveBeenCalled();

    const modified = setup("1. item", richText, "mod-enter");
    expect(modified.onKey("Enter", keyEvent("Enter"))).toBe(richText);
    expect(modified.submitComposer).not.toHaveBeenCalled();
    expect(modified.applyPromptReplacement).toHaveBeenCalledTimes(richText ? 1 : 0);
    expect(modified.onKey("Enter", keyEvent("Enter", false, true))).toBe(true);
    expect(modified.submitComposer).toHaveBeenCalledWith(undefined, "auto", "background");
  });
});
