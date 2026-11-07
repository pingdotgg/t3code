import { useState } from "react";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";
import { usePasteToFocusComposer } from "./usePasteToFocusComposer";
import { AssistantCitationChip } from "./AssistantCitationChip";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { page } from "vite-plus/test/browser";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { pasteTextToFocusComposer, shouldTypeToFocusComposer } from "./composerFocusRedirect";

const settings = vi.hoisted(() => ({ typingWithSelection: "composer" }));
vi.mock(import("~/hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  getClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    typingWithSelection: settings.typingWithSelection as "composer" | "cite",
  }),
}));

it("routes selected assistant text through Cite only when enabled", async () => {
  settings.typingWithSelection = "composer";
  const viewport = document.createElement("div");
  const source = document.createElement("p");
  source.dataset.assistantCitationSource = "message";
  source.textContent = "Selected assistant text";
  viewport.append(source);
  document.body.append(viewport);
  using _viewport = {
    [Symbol.dispose]: () => {
      window.getSelection()?.removeAllRanges();
      viewport.remove();
    },
  };
  const onCite = vi.fn(
    (
      _citation: AssistantCitation,
      _anchor: import("~/lib/assistantTextSelection").AssistantCitationSourceAnchor,
    ) => true,
  );
  await using _screen = await render(
    <AssistantSelectionToolbar
      viewport={viewport}
      threadRef={{
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      }}
      onCite={onCite}
    />,
    { router: false },
  ); // Selection handling does not use navigation.
  const select = async (name = "Cite selection in composer") => {
    const range = document.createRange();
    range.selectNodeContents(source);
    await act(async () => {
      source.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      source.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, isPrimary: true, button: 0 }),
      );
      source.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
    await expect.element(page.getByRole("button", { name })).toBeVisible();
  };
  await select();
  expect(
    shouldTypeToFocusComposer(new KeyboardEvent("keydown", { key: "a", cancelable: true })),
  ).toBe(true);
  expect(onCite).not.toHaveBeenCalled();
  const plainText = new DataTransfer();
  plainText.setData("text/plain", "composer paste");
  expect(pasteTextToFocusComposer(new ClipboardEvent("paste", { clipboardData: plainText }))).toBe(
    "composer paste",
  );
  settings.typingWithSelection = "cite";
  const copied = threadChipCopyTarget(
    { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") },
    "Copied thread",
  );
  const context = new DataTransfer();
  context.setData("text/plain", copied.value);
  context.setData(
    COMPOSER_CONTEXT_CLIPBOARD_MIME,
    encodeComposerContextFragment(copied.fragment!)!,
  );
  const pasteContext = new ClipboardEvent("paste", { clipboardData: context, cancelable: true });
  expect(pasteTextToFocusComposer(pasteContext)).toBe(copied.value);
  expect(pasteContext.defaultPrevented).toBe(false);
  const files = new DataTransfer();
  files.items.add(new File(["file"], "test.txt", { type: "text/plain" }));
  files.setData("text/plain", "file text");
  expect(
    pasteTextToFocusComposer(new ClipboardEvent("paste", { clipboardData: files })),
  ).toBeNull();
  for (const modifiers of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    expect(
      shouldTypeToFocusComposer(new KeyboardEvent("keydown", { key: "a", ...modifiers })),
    ).toBe(false);
  }
  expect(onCite).not.toHaveBeenCalled();
  viewport.dataset.surfaceLauncherKeys = "a";
  const launcherKey = new KeyboardEvent("keydown", { key: "a", cancelable: true });
  expect(shouldTypeToFocusComposer(launcherKey)).toBe(false);
  expect(launcherKey.defaultPrevented).toBe(false);
  expect(onCite).not.toHaveBeenCalled();
  delete viewport.dataset.surfaceLauncherKeys;
  await act(async () => {
    expect(
      shouldTypeToFocusComposer(new KeyboardEvent("keydown", { key: "a", cancelable: true })),
    ).toBe(false);
    expect(
      shouldTypeToFocusComposer(
        new KeyboardEvent("keydown", { key: "b", repeat: true, cancelable: true }),
      ),
    ).toBe(false);
    const chunk = new DataTransfer();
    chunk.setData("text/plain", "cd");
    expect(
      pasteTextToFocusComposer(
        new ClipboardEvent("paste", { clipboardData: chunk, cancelable: true }),
      ),
    ).toBeNull();
  });
  expect(onCite).toHaveBeenCalledTimes(1);
  expect(onCite.mock.lastCall?.[1]).toMatchObject({ initialComment: "abcd" });
  await select();
  const data = new DataTransfer();
  data.setData("text/plain", "dictated comment");
  await act(async () => {
    expect(
      pasteTextToFocusComposer(
        new ClipboardEvent("paste", { clipboardData: data, cancelable: true }),
      ),
    ).toBeNull();
    data.setData("text/plain", " continued");
    expect(
      pasteTextToFocusComposer(
        new ClipboardEvent("paste", { clipboardData: data, cancelable: true }),
      ),
    ).toBeNull();
  });
  expect(onCite.mock.lastCall?.[1]).toMatchObject({ initialComment: "dictated comment continued" });
  await select();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onCite).toHaveBeenCalledTimes(2);
  expect(shouldTypeToFocusComposer(new KeyboardEvent("keydown", { key: "z" }))).toBe(true);
  expect(onCite).toHaveBeenCalledTimes(2);
  source.dataset.assistantCitationSource = "m".repeat(513);
  await select();
  for (const key of ["a", "b"]) {
    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    expect(shouldTypeToFocusComposer(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  }
  const fallbackPaste = new ClipboardEvent("paste", { clipboardData: plainText, cancelable: true });
  expect(pasteTextToFocusComposer(fallbackPaste)).toBe("composer paste");
  expect(fallbackPaste.defaultPrevented).toBe(false);
  expect(onCite).toHaveBeenCalledTimes(2);
  source.textContent = "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1);
  await select("Selection is too long to cite");
  expect(shouldTypeToFocusComposer(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  expect(onCite).toHaveBeenCalledTimes(2);
});

function InputHarness({ viewport, onCancel }: { viewport: HTMLElement; onCancel: () => void }) {
  const [editor, setEditor] = useState<{
    citation: AssistantCitation;
    anchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const composerRef = {
    current: {
      insertTextAtEnd: () => {
        throw new Error("Main composer must not receive citation input");
      },
      isModelPickerOpen: () => false,
    } as Partial<ChatComposerHandle> as ChatComposerHandle,
  };
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef,
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  usePasteToFocusComposer(ThreadId.make("thread"), composerRef);
  return (
    <>
      <AssistantSelectionToolbar
        viewport={viewport}
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
        onCite={(citation, anchor) => {
          setEditor({ citation, anchor });
          return true;
        }}
      />
      {editor ? (
        <AssistantCitationChip
          citation={editor.citation}
          composer
          commentEditor={{
            open: true,
            sourceAnchor: editor.anchor,
            onSave: () => true,
            onOpenChange: (open) => {
              if (!open) {
                onCancel();
                setEditor(null);
              }
            },
          }}
        />
      ) : null}
    </>
  );
}

it.each(["Backspace", "Escape", "Enter", "side chat"])(
  "routes keyboard and paste into a mounting editor; %s edits, cancels, or consumes Enter without saving",
  async (editingKey) => {
    settings.typingWithSelection = "cite";
    const viewport = document.createElement("div");
    const source = document.createElement("p");
    source.dataset.assistantCitationSource = "message";
    source.textContent = "Selected assistant text";
    viewport.append(source);
    document.body.append(viewport);
    using _viewport = {
      [Symbol.dispose]: () => {
        window.getSelection()?.removeAllRanges();
        viewport.remove();
      },
    };
    const onCancel = vi.fn();
    await using _screen = await render(<InputHarness viewport={viewport} onCancel={onCancel} />);
    const range = document.createRange();
    range.selectNodeContents(source);
    await act(async () => {
      source.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      source.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, isPrimary: true, button: 0 }),
      );
      source.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
    await expect
      .element(page.getByRole("button", { name: "Cite selection in composer" }))
      .toBeVisible();
    const key = (key: string) =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    await act(async () => {
      if (editingKey === "side chat") viewport.dataset.sideChatPane = "true";
      key("a");
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "bx");
      document.body.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      if (editingKey === "side chat") return;
      key(editingKey);
      if (editingKey !== "Escape") {
        key("Delete");
        key("c");
      }
    });
    if (editingKey === "side chat") {
      expect(onCancel).not.toHaveBeenCalled();
      await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    } else if (editingKey === "Escape") {
      expect(onCancel).toHaveBeenCalledOnce();
      await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    } else {
      await expect
        .element(page.getByRole("textbox"))
        .toHaveValue(editingKey === "Backspace" ? "abc" : "abxc");
      const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
      await vi.waitFor(() => expect(document.activeElement).toBe(input));
      expect(input.selectionStart).toBe(input.value.length);
      expect(input.selectionEnd).toBe(input.value.length);
    }
  },
);
