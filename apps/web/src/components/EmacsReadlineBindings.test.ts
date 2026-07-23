import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppRouter } from "../router";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  getActiveShortcutMatchOptions,
  shouldYieldToCustomApplicationShortcut,
} from "./EmacsReadlineBindings";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-a"));

afterEach(() => {
  useTerminalUiStateStore.getState().removeTerminalUiState(threadRef);
  vi.unstubAllGlobals();
});

describe("EmacsReadlineBindings", () => {
  it("reads the active thread's terminal state into shortcut match options", () => {
    class TestElement {
      readonly testElement = true;
    }
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("document", { activeElement: null, querySelector: () => null });
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    const router = {
      state: {
        matches: [
          {
            params: {
              environmentId: threadRef.environmentId,
              threadId: threadRef.threadId,
            },
          },
        ],
      },
    } as unknown as AppRouter;

    expect(getActiveShortcutMatchOptions(router).context).toMatchObject({
      terminalFocus: false,
      terminalOpen: true,
      previewFocus: false,
      previewOpen: false,
      modelPickerOpen: false,
    });
  });

  it("includes model-picker visibility in shortcut match options", () => {
    class TestElement {
      readonly testElement = true;
    }
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("document", {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === "[data-model-picker-content]" ? new TestElement() : null,
    });
    const router = { state: { matches: [] } } as unknown as AppRouter;

    expect(getActiveShortcutMatchOptions(router).context?.modelPickerOpen).toBe(true);
  });

  it("honors when-guard context while resolving custom shortcut precedence", () => {
    const keybindings: ResolvedKeybindingsConfig = [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
        whenAst: { type: "identifier", name: "terminalOpen" },
      },
    ];
    const event = {
      altKey: false,
      ctrlKey: true,
      key: "k",
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent;

    expect(
      shouldYieldToCustomApplicationShortcut(event, keybindings, {
        platform: "Linux",
        context: { terminalOpen: false },
      }),
    ).toBe(false);
    expect(
      shouldYieldToCustomApplicationShortcut(event, keybindings, {
        platform: "Linux",
        context: { terminalOpen: true },
      }),
    ).toBe(true);
  });
});
