import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { createRef, useLayoutEffect, useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { isMacPlatform } from "../../lib/utils";
import {
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
} from "../../promptStashStore";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import {
  addPreparingComposerImages,
  countPreparingComposerImages,
  removePreparingComposerImages,
} from "./preparingComposerImages";
import { BackgroundThreadContext } from "./backgroundThread";
import { useComposerStash } from "./useComposerStash";

type StashInput = Parameters<typeof useComposerStash>[0];

function Harness({ input }: { input: StashInput }) {
  useComposerStash(input);
  return null;
}

it("keeps the draft when stashing while a pasted image is still compressing", async () => {
  const target = DraftId.make("stash-preparing-image");
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearComposerContent(target),
  };
  using _stash = {
    [Symbol.dispose]: () => {
      writePromptStashStorageForTest("");
      removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
    },
  };
  addPreparingComposerImages(target, [
    {
      id: "pasted",
      name: "shot.png",
      file: new File(["png"], "shot.png", { type: "image/png" }),
      hidden: false,
    },
  ]);
  using _preparing = {
    [Symbol.dispose]: () => removePreparingComposerImages(target, new Set(["pasted"])),
  };
  const environmentId = EnvironmentId.make("stash-env");
  const promptRef = { current: "Describe this screenshot" };
  const input = {
    environmentId,
    composerDraftTarget: target,
    promptRef,
    readAttachmentDraft: () => ({ images: [], files: [] }),
    readTerminalContexts: () => [],
    routeThreadRef: { environmentId, threadId: ThreadId.make("stash-thread") },
    projectSelectionRequired: false,
    pendingUserInputs: [],
    activePendingProgress: null,
    prompt: promptRef.current,
    composerMenuOpen: false,
    isComposerCollapsedMobile: false,
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerThreadContexts: [],
    attachmentTargetKey: target,
    isComposerDraftTargetOpen: () => true,
    composerEditorRef: { current: null },
    isRevertingCheckpoint: () => false,
    pendingThreadImportsRef: { current: new Map() },
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    importContextRecords: () => new Map(),
    expandMobileComposer: vi.fn(),
  } satisfies StashInput;
  await using _screen = await render(<Harness input={input} />);

  const mod = isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  await act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ...mod, bubbles: true, cancelable: true }),
    );
  });

  expect(usePromptStashStore.getState().entries).toEqual([]);
  expect(promptRef.current).toBe("Describe this screenshot");
  expect(countPreparingComposerImages(target)).toBe(1);
});

it("stashes a side chat's prompt when Mod+S is pressed inside its pane", async () => {
  const target = DraftId.make("stash-side-chat");
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearComposerContent(target),
  };
  using _stash = {
    [Symbol.dispose]: () => {
      writePromptStashStorageForTest("");
      removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
    },
  };
  const environmentId = EnvironmentId.make("stash-env");
  const promptRef = { current: "Side chat question" };
  const input = {
    environmentId,
    composerDraftTarget: target,
    promptRef,
    readAttachmentDraft: () => ({ images: [], files: [] }),
    readTerminalContexts: () => [],
    routeThreadRef: { environmentId, threadId: ThreadId.make("stash-side-thread") },
    projectSelectionRequired: false,
    pendingUserInputs: [],
    activePendingProgress: null,
    prompt: promptRef.current,
    composerMenuOpen: false,
    isComposerCollapsedMobile: false,
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerThreadContexts: [],
    attachmentTargetKey: target,
    isComposerDraftTargetOpen: () => true,
    composerEditorRef: { current: null },
    isRevertingCheckpoint: () => false,
    pendingThreadImportsRef: { current: new Map() },
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    importContextRecords: () => new Map(),
    expandMobileComposer: vi.fn(),
  } satisfies StashInput;
  // SideThreadPane renders an on-screen side chat this way.
  await using screen = await render(
    <BackgroundThreadContext value>
      <div data-side-chat-pane="stash-side-thread">
        <textarea aria-label="Side chat composer" />
        <Harness input={input} />
      </div>
    </BackgroundThreadContext>,
  );

  const composer = screen.container.querySelector("textarea")!;
  composer.focus();
  const mod = isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  const event = new KeyboardEvent("keydown", { key: "s", ...mod, bubbles: true, cancelable: true });
  await act(() => {
    composer.dispatchEvent(event);
  });

  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => {
    expect(usePromptStashStore.getState().entries.map((entry) => entry.prompt)).toEqual([
      "Side chat question",
    ]);
  });
});

it("resets editor image history when stashing an image-only draft", async () => {
  const target = DraftId.make("stash-image-only");
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearComposerContent(target),
  };
  using _stash = {
    [Symbol.dispose]: () => {
      writePromptStashStorageForTest("");
      removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
    },
  };
  // 1x1 transparent PNG so browser image compression succeeds during stash encoding.
  const pngBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const file = new File([pngBytes], "shot.png", { type: "image/png" });
  const previewUrl = URL.createObjectURL(file);
  using _url = {
    [Symbol.dispose]: () => URL.revokeObjectURL(previewUrl),
  };
  useComposerDraftStore.getState().addImages(target, [
    {
      type: "image",
      id: "img-stash-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: file.size,
      previewUrl,
      file,
    },
  ]);

  const environmentId = EnvironmentId.make("stash-env");
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const onImageHistoryChange = vi.fn();
  let restoreEntry:
    | ((
        entry: typeof usePromptStashStore.getState extends () => { entries: readonly (infer E)[] }
          ? E
          : never,
      ) => Promise<void>)
    | undefined;

  function StashEditorHarness() {
    const promptRef = useRef("");
    const [historyResetKey, setHistoryResetKey] = useState(0);
    const { restoreStashEntryStable } = useComposerStash({
      environmentId,
      composerDraftTarget: target,
      promptRef,
      readAttachmentDraft: () => ({
        images: useComposerDraftStore.getState().getComposerDraft(target)?.images ?? [],
        files: [],
      }),
      readTerminalContexts: () => [],
      routeThreadRef: { environmentId, threadId: ThreadId.make("stash-image-thread") },
      projectSelectionRequired: false,
      pendingUserInputs: [],
      activePendingProgress: null,
      prompt: "",
      composerMenuOpen: false,
      isComposerCollapsedMobile: false,
      composerPreviewAnnotations: [],
      composerReviewComments: [],
      composerThreadContexts: [],
      attachmentTargetKey: target,
      isComposerDraftTargetOpen: () => true,
      composerEditorRef: editorRef,
      isRevertingCheckpoint: () => false,
      pendingThreadImportsRef: { current: new Map() },
      setComposerCursor: vi.fn(),
      setComposerTrigger: vi.fn(),
      onDraftCleared: () => setHistoryResetKey((generation) => generation + 1),
      importContextRecords: () => new Map(),
      expandMobileComposer: vi.fn(),
    });
    useLayoutEffect(() => {
      restoreEntry = restoreStashEntryStable;
    });

    return (
      <ComposerPromptEditor
        draftKey={target}
        historyResetKey={historyResetKey}
        editorRef={editorRef}
        value=""
        cursor={0}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onImageHistoryChange={onImageHistoryChange}
        onPaste={() => {}}
      />
    );
  }

  await using screen = await render(<StashEditorHarness />);
  const currentEditor = (): Editor => {
    const el = screen.container.querySelector(".tiptap") as
      | (HTMLElement & { editor?: Editor })
      | null;
    if (!el?.editor) throw new Error("expected tiptap editor");
    return el.editor;
  };

  await act(() => {
    currentEditor().view.focus();
    expect(
      editorRef.current?.recordImageHistory("add", target, [
        {
          id: "img-stash-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: file.size,
          file,
          index: 0,
        },
      ]),
    ).toBe(true);
  });

  const mod = isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  await act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ...mod, bubbles: true, cancelable: true }),
    );
  });

  await vi.waitFor(() => {
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.images ?? []).toHaveLength(0);
    expect(usePromptStashStore.getState().entries).toHaveLength(1);
    expect(usePromptStashStore.getState().entries[0]?.pendingImageCount).toBe(0);
  });

  // Focused Undo and Redo must not replay the stashed image into the emptied draft.
  await act(() => {
    currentEditor().view.focus();
    currentEditor().commands.undo();
    currentEditor().commands.redo();
  });
  expect(onImageHistoryChange).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.images ?? []).toHaveLength(0);

  // Restoring the stashed entry brings the image back normally.
  const entry = usePromptStashStore.getState().entries[0]!;
  await act(async () => {
    await restoreEntry?.(entry);
  });
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft(target)
      ?.images.map((image) => image.name),
  ).toEqual(["shot.png"]);
});
