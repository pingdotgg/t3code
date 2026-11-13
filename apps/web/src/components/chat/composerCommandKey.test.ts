import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DraftId } from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

it.each(["Enter", "Tab"])("does not accept a stale fuzzy mention on %s during debounce", (key) => {
  const value = "Check @README and fix it";
  const selected: ComposerCommandItem = {
    id: "path:README.md",
    type: "path",
    path: "README.md",
    label: "README.md",
    description: "",
    pathKind: "file",
    searchTarget: { environmentId: null, cwd: null, query: "READ" },
  };
  const submitComposer = vi.fn();
  const onSelectComposerItem = vi.fn();
  const input: Parameters<typeof composerCommandKeyHandler>[0] = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut: "enter",
    routeKind: "draft",
    phase: "ready",
    canSteer: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryEntries: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("test"),
    promptRef: { current: value },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: { current: null },
    composerMenuOpenRef: { current: true },
    composerMenuItemsRef: { current: [selected] },
    activeComposerMenuItemRef: { current: selected },
    setComposerDraftPrompt: vi.fn(),
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    dismissComposerTrigger: vi.fn(),
    nudgeComposerMenuHighlight: vi.fn(),
    onSelectComposerItem,
    submitComposer,
    resolveActiveComposerTrigger: () => ({
      trigger: { kind: "path", query: "README and fix it", rangeStart: 6, rangeEnd: value.length },
    }),
    readComposerSnapshot: () => ({ value }),
    applyPromptReplacement: () => false,
    promptSuggestion: null,
    dismissPromptSuggestion: vi.fn(),
  };
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
  } as KeyboardEvent;
  composerCommandKeyHandler(input)(key, event);
  expect(onSelectComposerItem).not.toHaveBeenCalled();
  expect(submitComposer).toHaveBeenCalledTimes(key === "Enter" ? 1 : 0);
  selected.path = "docs/README and fix it.md";
  composerCommandKeyHandler(input)(key, event);
  expect(onSelectComposerItem).toHaveBeenCalledExactlyOnceWith(selected);
  expect(submitComposer).toHaveBeenCalledTimes(key === "Enter" ? 1 : 0);
  composerCommandKeyHandler({ ...input, resolveActiveComposerTrigger: () => ({ trigger: null }) })(
    key,
    event,
  );
  expect(onSelectComposerItem).toHaveBeenCalledTimes(1);
  expect(submitComposer).toHaveBeenCalledTimes(key === "Enter" ? 2 : 0);
});
