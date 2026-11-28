import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerCommandKeyHandler } from "./composerCommandKey";

describe("prompt suggestion keys", () => {
  it.each([
    ["tab", "Escape", false, "dismissed"],
    ["escape", "Escape", false, "accepted"],
    ["shift+tab", "Tab", true, "accepted"],
  ] as const)("bound to %s, %s (shift: %s) is %s", (binding, key, shiftKey, outcome) => {
    const accept = vi.fn(() => true);
    const dismiss = vi.fn();
    // Only the inputs these keys reach on an empty draft.
    const handle = composerCommandKeyHandler({
      keybindings: mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          { key: binding, command: "composer.acceptPromptSuggestion", when: "composerFocus" },
        ]),
      ),
      getShortcutContext: () => ({ editableFocus: true }),
      sendShortcut: "enter",
      routeKind: "server",
      phase: "ready",
      promptRef: { current: "" },
      composerDraftTarget: "draft",
      resolveActiveComposerTrigger: () => ({ trigger: null }),
      promptSuggestion: "Run the tests",
      applyPromptReplacement: accept,
      dismissPromptSuggestion: dismiss,
    } as unknown as Parameters<typeof composerCommandKeyHandler>[0]);

    handle(key, {
      key,
      shiftKey,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 0,
      target: null,
    } as unknown as KeyboardEvent);

    expect({ accepted: accept.mock.calls.length, dismissed: dismiss.mock.calls.length }).toEqual({
      accepted: outcome === "accepted" ? 1 : 0,
      dismissed: outcome === "dismissed" ? 1 : 0,
    });
  });
});
