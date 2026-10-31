import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
  addPreparingComposerImages,
  countPreparingComposerImages,
  removePreparingComposerImages,
} from "./preparingComposerImages";
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
    { id: "pasted", name: "shot.png", file: new File(["png"], "shot.png", { type: "image/png" }) },
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
