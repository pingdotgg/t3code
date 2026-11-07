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
vi.mock(import("~/hooks/useSettings"), () => ({
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
  source.textContent = "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1);
  await select("Selection is too long to cite");
  expect(shouldTypeToFocusComposer(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  expect(onCite).toHaveBeenCalledTimes(2);
});
