import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";

function setup(prompt: string, composerRichTextEnabled: boolean) {
  const applyPromptReplacement = vi.fn(() => true);
  const submitComposer = vi.fn();
  const input: Parameters<typeof composerCommandKeyHandler>[0] = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut: "enter",
    composerRichTextEnabled,
    routeKind: "draft",
    phase: "ready",
    canSteer: true,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
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
    nudgeComposerMenuHighlight: vi.fn(),
    onSelectComposerItem: vi.fn(),
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: prompt }),
    applyPromptReplacement,
    submitComposer,
    promptSuggestion: null,
    dismissPromptSuggestion: vi.fn(),
  };
  return {
    onKey: composerCommandKeyHandler(input),
    applyPromptReplacement,
    submitComposer,
  };
}

function keyEvent(key: string, shiftKey: boolean) {
  return { key, shiftKey, ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent;
}

describe.each([false, true])("composer list keys (rich text: %s)", (richText) => {
  it.each([
    { prompt: "1. item", key: "Enter", shift: true },
    { prompt: "1. item", key: "Tab", shift: false },
    { prompt: "  1. item", key: "Tab", shift: true },
  ])("edits lists only in rich text for $key on $prompt", ({ prompt, key, shift }) => {
    const { onKey, applyPromptReplacement, submitComposer } = setup(prompt, richText);
    onKey(key, keyEvent(key, shift));
    expect(applyPromptReplacement).toHaveBeenCalledTimes(richText ? 1 : 0);
    expect(submitComposer).not.toHaveBeenCalled();
  });
});
