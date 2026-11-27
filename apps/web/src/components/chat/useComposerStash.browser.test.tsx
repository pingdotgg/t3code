import { EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { verifyStashedAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { isMacPlatform } from "../../lib/utils";
import {
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
} from "../../promptStashStore";
import { ToastProvider } from "../ui/toast";
import {
  addPreparingComposerImages,
  countPreparingComposerImages,
  removePreparingComposerImages,
} from "./preparingComposerImages";
import { BackgroundThreadContext } from "./backgroundThread";
import { useComposerStash } from "./useComposerStash";

vi.mock(import("../../lib/attachmentUploadQueue"), { spy: true });

type StashInput = Parameters<typeof useComposerStash>[0];

function Harness({ input }: { input: StashInput }) {
  const { stashQueue, restoreStashEntryStable } = useComposerStash(input);
  const entry = stashQueue[0];
  return entry ? (
    <button onClick={() => void restoreStashEntryStable(entry)}>Restore</button>
  ) : null;
}

it("reports a skipped expired file only as over the attachment limit", async () => {
  const target = DraftId.make("stash-attachment-limit");
  const draft = useComposerDraftStore.getState();
  using _cleanup = {
    [Symbol.dispose]: () => {
      draft.clearComposerContent(target);
      writePromptStashStorageForTest("");
      removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
    },
  };
  const environmentId = EnvironmentId.make("stash-env");
  vi.mocked(verifyStashedAttachmentUpload).mockResolvedValueOnce({ status: "missing" });
  usePromptStashStore.getState().stashEntry({
    id: "expired-file-stash",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "Review this report",
    attachments: [],
    droppedImageNames: [],
    files: [
      {
        id: "report-file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        attachmentId: "expired-report-upload",
        environmentId,
      },
    ],
  });
  draft.addFiles(
    target,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
      type: "file",
      id: `existing-${index}`,
      name: `existing-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
      file: new File(["x"], `existing-${index}.txt`, { type: "text/plain" }),
    })),
  );
  const promptRef = { current: "" };
  await using screen = await render(
    <ToastProvider timeout={0}>
      <Harness
        input={{
          environmentId,
          composerDraftTarget: target,
          promptRef,
          readAttachmentDraft: () => draft.getComposerDraft(target) ?? { images: [], files: [] },
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
        }}
      />
    </ToastProvider>,
  );

  await screen.getByRole("button", { name: "Restore" }).click();

  const warning = page.getByText(/^report\.pdf could not be restored/);
  await expect.element(warning).toBeVisible();
  expect(warning.element().textContent).toBe(
    `report.pdf could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit.`,
  );
});

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
