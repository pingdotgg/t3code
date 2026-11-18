import { createMemoryHistory } from "@tanstack/react-router";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RunId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import appStyles from "~/index.css?inline";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, hydrateImagesFromPersisted, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { environmentContextRecord, imageContextReference } from "~/lib/composerContextRecords";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { usePromptStashStore } from "~/promptStashStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { environmentThreadDetails } from "~/state/threads";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerAssetUrls,
  answerRpc,
  assistantItem,
  dispatchedCommands,
  emitThreadEvent,
  hasPendingAssetUrl,
  installFakeEnvironment,
  rejectPendingCommand,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../test/render";
import { openExpandedImagePreview } from "./chat/ExpandedImageDialog";
import { buildExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { toastManager } from "./ui/toast";
import { serializeComposerImages } from "./chat/composerImagePersistence";
import {
  addImageEditorObject,
  createImageEditorDocument,
} from "./image-editor/imageEditorDocument";
import {
  addPreparingComposerImages,
  cancelPreparingComposerImages,
  countPreparingComposerImages,
  removePreparingComposerImages,
} from "./chat/preparingComposerImages";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

it("keeps the draft intact when image edits exceed reserved attachment slots and admits the exact boundary after a slot is released", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(1800, 1000);
  const style = document.createElement("style");
  style.textContent = appStyles;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const thread = threadWithHistory("image-edit-attachment-boundary", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const target = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  useRightPanelStore.getState().close(target);
  const key = scopedThreadKey(target);
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const file = new File([PNG], "original.png", { type: "image/png" });
  store.setPrompt(target, "Keep this draft");
  store.addImage(target, {
    type: "image",
    id: "image-edit-original",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
  });
  store.addFiles(
    target,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 4 }, (_, index) => {
      const file = new File(["notes"], `notes-${index}.txt`, { type: "text/plain" });
      return {
        type: "file" as const,
        id: `image-edit-notes-${index}`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
    }),
  );
  addPreparingComposerImages(key, [
    { id: "image-edit-preparing-1", name: "preparing-1.png", file, hidden: false },
    { id: "image-edit-preparing-2", name: "preparing-2.png", file, hidden: false },
    { id: "image-edit-preparing-3", name: "preparing-3.png", file, hidden: false },
  ]);
  using _preparing = { [Symbol.dispose]: () => cancelPreparingComposerImages(key) };
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _uploads = acceptAttachmentUploads();
  await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Keep this draft");
  const before = store.getComposerDraft(target)!;
  const preview = buildExpandedImagePreview(before.images, "image-edit-original");
  if (!preview) throw new Error("The original attachment has no image preview");
  await act(() => openExpandedImagePreview(key, preview));
  await userEvent.click(page.getByRole("button", { name: "Edit image", exact: true }));
  const canvas = page.getByRole("application", { name: "Editable annotations" });
  await expect.element(canvas).toBeVisible();
  await act(() => (canvas.element() as SVGSVGElement).focus());
  await userEvent.keyboard("v{Enter}");
  await expect.element(canvas).toHaveFocus();
  expect(store.getComposerDraft(target)?.prompt).toBe("Keep this draft");
  await userEvent.fill(
    page.getByRole("textbox", { name: "Edit instructions", exact: true }),
    "Change the image to blue",
  );
  await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
  await expect
    .element(
      page.getByRole("alert").filter({
        hasText: `A message can contain up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments`,
      }),
    )
    .toBeVisible();
  const rejected = store.getComposerDraft(target)!;
  expect(rejected.prompt).toBe(before.prompt);
  expect(rejected.images).toBe(before.images);
  expect(rejected.files).toBe(before.files);
  expect(countPreparingComposerImages(key)).toBe(3);

  await act(() => removePreparingComposerImages(key, new Set(["image-edit-preparing-1"])));
  await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() => expect(store.getComposerDraft(target)?.images).toHaveLength(2));
  const accepted = store.getComposerDraft(target)!;
  expect(accepted.prompt).toContain("Keep this draft");
  expect(accepted.prompt).toContain("Change the image to blue");
  expect(accepted.files).toBe(before.files);
  expect(accepted.images[0]?.id).toBe(before.images[0]?.id);
  expect(accepted.images[0]?.file).not.toBe(before.images[0]?.file);
  expect(accepted.images.map((image) => image.name)).toEqual([
    "original-original.png",
    "original-guidance.png",
  ]);
  expect(accepted.images.length + accepted.files.length + countPreparingComposerImages(key)).toBe(
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
});

it("replaces a staged image request and removes its old mask and unchanged instructions when the guidance is edited again", async () => {
  const style = document.createElement("style");
  style.textContent = appStyles;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const thread = threadWithHistory("restage-image-edit", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const target = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const key = scopedThreadKey(target);
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const file = new File([PNG, new Uint8Array(1_300_000)], "robot.png", { type: "image/png" });
  store.addImage(target, {
    type: "image",
    id: "restage-original",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl: URL.createObjectURL(file),
    imageEditor: {
      originalFile: file,
      document: addImageEditorObject(createImageEditorDocument(1, 1), {
        id: "remove",
        kind: "remove",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
        color: "#ff0000",
        strokeWidth: 1,
        points: [{ x: 0, y: 0 }],
      }),
    },
  });
  const inlineReference = formatInlineContextReference(
    imageContextReference(store.getComposerDraft(target)!.images[0]!),
  );
  store.setPrompt(target, `Keep my introduction ${inlineReference}`);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _uploads = acceptAttachmentUploads();
  const open = async (id: string, still = false) => {
    const preview = buildExpandedImagePreview(store.getComposerDraft(target)!.images, id)!;
    await act(() => openExpandedImagePreview(key, preview));
    await userEvent.click(page.getByRole("button", { name: "Edit image", exact: true }));
    if (!still)
      await expect.element(page.getByRole("textbox", { name: "Edit instructions" })).toBeEnabled();
  };
  await open("restage-original");
  await userEvent.fill(
    page.getByRole("textbox", { name: "Edit instructions" }),
    "Remove the old mark",
  );
  await userEvent.click(page.getByRole("button", { name: "Remove background", exact: true }));
  await userEvent.click(page.getByRole("combobox", { name: "Regenerate aspect ratio" }));
  await userEvent.click(page.getByRole("option", { name: "Portrait · 4:5" }));
  await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() => expect(store.getComposerDraft(target)?.images).toHaveLength(3));
  let first = store.getComposerDraft(target)!;
  expect(first.prompt).toContain(inlineReference);
  expect(first.images.map((image) => image.name)).toEqual([
    "robot-original.png",
    "robot-guidance.png",
    "robot-mask.png",
  ]);
  let guidance = first.images.find((image) => image.imageEditor)!;
  expect(guidance.imageEditRequest?.imageIds).toEqual(first.images.map((image) => image.id));
  const originalPrompt = first.prompt;
  await open(guidance.id);
  await expect
    .element(page.getByRole("textbox", { name: "Edit instructions" }))
    .toHaveValue("Remove the old mark");
  await expect
    .element(page.getByRole("button", { name: "Remove background", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(page.getByRole("combobox", { name: "Regenerate aspect ratio" }))
    .toHaveTextContent("Portrait · 4:5");
  await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() =>
    expect(store.getComposerDraft(target)?.images.some((image) => image.id === guidance.id)).toBe(
      false,
    ),
  );
  first = store.getComposerDraft(target)!;
  guidance = first.images.find((image) => image.imageEditor)!;
  expect(first.prompt).toBe(originalPrompt);
  expect(first.images).toHaveLength(3);
  const persisted = await serializeComposerImages(first.images, []);
  expect(persisted.find((image) => image.id === guidance.id)?.imageEditor).toBeUndefined();
  const hydrated = hydrateImagesFromPersisted(persisted);
  const recovered = hydrated.find((image) => image.id === guidance.id)!;
  expect(recovered.imageEditor?.originalFile.name).toBe("robot.png");
  expect(await recovered.imageEditor!.originalFile.arrayBuffer()).toEqual(
    await first.images[0]!.file.arrayBuffer(),
  );
  await act(() => {
    for (const image of hydrated) store.replaceImage(target, image.id, image);
  });
  await open(guidance.id);
  await expect
    .element(page.getByRole("textbox", { name: "Edit instructions" }))
    .toHaveValue("Remove the old mark");
  await expect
    .element(page.getByRole("button", { name: "Remove background", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(page.getByRole("combobox", { name: "Regenerate aspect ratio" }))
    .toHaveTextContent("Portrait · 4:5");
  await userEvent.click(page.getByRole("button", { name: "Remove background", exact: true }));
  await userEvent.click(page.getByRole("combobox", { name: "Regenerate aspect ratio" }));
  await userEvent.click(page.getByRole("option", { name: "Original", exact: true }));
  await userEvent.click(
    page.getByRole("button", { name: "Revert Removal selection", exact: true }),
  );
  await userEvent.fill(
    page.getByRole("textbox", { name: "Edit instructions" }),
    "Make the background blue",
  );
  await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() => expect(store.getComposerDraft(target)?.images).toHaveLength(2));
  const restaged = store.getComposerDraft(target)!;
  expect(restaged.images.map((image) => image.name)).toEqual([
    "robot-original.png",
    "robot-guidance.png",
  ]);
  expect(restaged.prompt).toContain("Keep my introduction");
  expect(restaged.prompt).toContain(inlineReference);
  expect(restaged.images[0]?.id).toBe("restage-original");
  expect(restaged.prompt).toContain("Make the background blue");
  expect(restaged.prompt).not.toContain("Remove the old mark");
  expect(restaged.prompt).not.toContain("Remove the areas painted red");
  expect(restaged.prompt.match(/Edit the attached original image/g)).toHaveLength(1);
  const stagedGuidance = restaged.images.find((image) => image.imageEditor)!;
  const gif = new File(
    [
      Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (char) =>
        char.charCodeAt(0),
      ),
    ],
    "animation.gif",
    { type: "image/gif" },
  );
  const animation = {
    type: "image" as const,
    id: "restage-animation",
    file: gif,
    name: gif.name,
    mimeType: gif.type,
    sizeBytes: gif.size,
    previewUrl: URL.createObjectURL(gif),
  };
  const context = "Frame timing: frame 1 100ms; frame 2 250ms. Return the edited animation.";
  // Restore the same metadata a staged frame-sheet request retains across a draft reload.
  await act(() => {
    store.addImage(target, animation);
    store.replaceImage(target, stagedGuidance.id, {
      ...stagedGuidance,
      imageEditRequest: {
        ...stagedGuidance.imageEditRequest!,
        imageIds: [...restaged.images.map((image) => image.id), animation.id],
        prompt: stagedGuidance.imageEditRequest!.prompt,
        animation: { originalId: animation.id, context },
      },
    });
  });
  await open(stagedGuidance.id);
  await userEvent.fill(
    page.getByRole("textbox", { name: "Edit instructions" }),
    "Make frame two green",
  );
  await userEvent.click(page.getByRole("button", { name: "Remove background", exact: true }));
  await userEvent.click(page.getByRole("combobox", { name: "Regenerate aspect ratio" }));
  await userEvent.click(page.getByRole("option", { name: "Portrait · 4:5", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() =>
    expect(store.getComposerDraft(target)?.prompt).toContain("Make frame two green"),
  );
  const frames = store.getComposerDraft(target)!;
  expect(frames.images.map((image) => image.name)).toEqual([
    "animation.gif",
    "robot-original.png",
    "robot-guidance.png",
  ]);
  expect(await frames.images[0]!.file.arrayBuffer()).toEqual(await gif.arrayBuffer());
  expect(frames.images[0]?.id).toBe(animation.id);
  expect(frames.prompt).toContain(context);
  expect(frames.prompt).toContain("Make frame two green");
  expect(frames.prompt).not.toContain("Make the background blue");
  expect(frames.images[2]!.imageEditRequest?.animation).toEqual({
    originalId: frames.images[0]!.id,
    context,
  });
  {
    const countBefore = store.getComposerDraft(target)!.images.length;
    await open(animation.id, true);
    await userEvent.click(page.getByRole("button", { name: "Edit a still frame", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Edit a still frame", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Edit instructions" })).toBeEnabled();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Edit instructions" }),
      "Make a separate blue still",
    );
    await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
    await expect
      .element(page.getByRole("textbox", { name: "Edit instructions" }))
      .not.toBeInTheDocument();
    const after = store.getComposerDraft(target)!;
    expect(after.images.find((image) => image.id === animation.id)?.file).toBe(
      frames.images[0]!.file,
    );
    expect(after.images).toHaveLength(countBefore + 2);
    expect(
      after.images.find((image) => image.id === frames.images[2]!.id)?.imageEditRequest,
    ).toEqual(frames.images[2]!.imageEditRequest);
    expect(after.prompt).toContain(context);
  }
  {
    const countBefore = store.getComposerDraft(target)!.images.length;
    const originalId = "shared-original";
    await act(() =>
      store.addImages(
        target,
        [
          {
            type: "image",
            id: originalId,
            name: file.name,
            file,
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: URL.createObjectURL(file),
            imageEditor: guidance.imageEditor!,
          },
        ],
        { allowDuplicates: true },
      ),
    );
    await open(originalId);
    await userEvent.fill(
      page.getByRole("textbox", { name: "Edit instructions" }),
      "First shared request",
    );
    await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
    await vi.waitFor(() =>
      expect(store.getComposerDraft(target)?.images).toHaveLength(countBefore + 3),
    );
    const firstShared = store
      .getComposerDraft(target)!
      .images.find((image) => image.imageEditRequest?.imageIds.includes(originalId))!;
    const firstOriginal = store
      .getComposerDraft(target)!
      .images.find((image) => image.id === originalId)!;
    await expect
      .element(page.getByRole("textbox", { name: "Edit instructions" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(store.getComposerDraft(target)?.prompt).toContain(
        firstShared.imageEditRequest!.prompt,
      ),
    );
    await open(originalId);
    await userEvent.fill(
      page.getByRole("textbox", { name: "Edit instructions" }),
      "Second shared request",
    );
    await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
    await vi.waitFor(() =>
      expect(store.getComposerDraft(target)?.images).toHaveLength(countBefore + 5),
    );
    const staged = store.getComposerDraft(target)!;
    const second = staged.images.find((image) =>
      image.imageEditRequest?.prompt.includes("Second shared request"),
    )!;
    await expect
      .element(page.getByRole("textbox", { name: "Edit instructions" }))
      .not.toBeInTheDocument();
    const secondOriginalId = second.imageEditRequest!.editor!.originalId;
    expect(secondOriginalId).not.toBe(originalId);
    expect(staged.images.find((image) => image.id === originalId)?.file).toBe(firstOriginal.file);
    await vi.waitFor(() => {
      expect(store.getComposerDraft(target)?.prompt).toContain(
        firstShared.imageEditRequest!.prompt,
      );
      expect(store.getComposerDraft(target)?.prompt).toContain(second.imageEditRequest!.prompt);
    });
    // Older saved drafts can still have two requests sharing the same clean companion.
    await act(() => {
      store.replaceImage(target, second.id, {
        ...second,
        imageEditRequest: {
          ...second.imageEditRequest!,
          imageIds: second.imageEditRequest!.imageIds.map((id) =>
            id === secondOriginalId ? originalId : id,
          ),
          editor: { ...second.imageEditRequest!.editor!, originalId },
        },
      });
      store.removeImage(target, secondOriginalId);
    });
    const shared = store.getComposerDraft(target)!;
    const other = firstShared;
    await open(second.id);
    await userEvent.fill(
      page.getByRole("textbox", { name: "Edit instructions" }),
      "Refresh the second request",
    );
    await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
    await expect
      .element(page.getByRole("textbox", { name: "Edit instructions" }))
      .not.toBeInTheDocument();
    const after = store.getComposerDraft(target)!;
    for (const id of other.imageEditRequest!.imageIds) {
      const before = shared.images.find((image) => image.id === id)!;
      expect(after.images.find((image) => image.id === id)?.file).toBe(before.file);
    }
    expect(
      after.images.some((image) => image.id === other.imageEditRequest!.editor!.originalId),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(store.getComposerDraft(target)?.prompt).toContain(other.imageEditRequest!.prompt),
    );
    await vi.waitFor(() =>
      expect(store.getComposerDraft(target)?.prompt).toContain("Refresh the second request"),
    );
  }
});

/** Accepts every attachment upload without sending its bytes, until disposed. */
function acceptAttachmentUploads(): Disposable {
  const mint = answerRpc(WS_METHODS.attachmentsCreateUploadUrl, () =>
    Effect.succeed({ attachmentId: "upload-1", relativeUrl: "/upload", expiresAt: 0 }),
  );
  // Sending verifies each ready upload still exists on the server.
  const verify = answerRpc(WS_METHODS.assetsCreateUrl, () =>
    Effect.succeed({ relativeUrl: "/upload-1", expiresAt: 0 }),
  );
  const status = vi.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(200);
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    queueMicrotask(() => this.dispatchEvent(new ProgressEvent("load")));
  });
  return {
    [Symbol.dispose]: () => {
      send.mockRestore();
      status.mockRestore();
      mint[Symbol.dispose]();
      verify[Symbol.dispose]();
    },
  };
}

/** Holds every call to `method` until `release`, then ends it with `end`, until disposed. */
function holdRpc<Input>(method: string, end: Effect.Effect<never, Error>) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Input[] = [];
  const answer = answerRpc(method, (input: Input) => {
    calls.push(input);
    return Effect.promise(() => held).pipe(Effect.andThen(end));
  });
  return { calls, release, [Symbol.dispose]: () => answer[Symbol.dispose]() };
}

it.each([
  { source: "assistant", entry: "preview" },
  { source: "assistant", entry: "context" },
  { source: "assistant", entry: "file-preview" },
])(
  "stages edits from thread Markdown in a $source surface through $entry without sending a turn",
  async ({ source, entry }) => {
    const style = document.createElement("style");
    style.textContent = appStyles;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    const seed = threadWithHistory(`markdown-image-edit-${source}-${entry}`, 1);
    const markdown =
      entry !== "preview"
        ? "![Editable source](/tmp/generated-source.png)"
        : "![Editable source](./editable-source.png)";
    const thread = {
      ...seed,
      items: seed.items.map((item) =>
        item.type === `${source}_message` ? { ...item, text: markdown } : item,
      ),
    };
    using _environment = installFakeEnvironment([thread]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const target = scopeThreadRef(ENVIRONMENT_ID, thread.id);
    useRightPanelStore.getState().close(target);
    const store = useComposerDraftStore.getState();
    using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
    store.setPrompt(target, "Keep my draft");
    const url = URL.createObjectURL(new Blob([PNG], { type: "image/png" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    using _assets = answerRpc(WS_METHODS.assetsCreateUrl, () =>
      Effect.succeed({ relativeUrl: url, expiresAt: 4_102_444_800_000 }),
    );
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    const thumbnail = page.getByRole("button", { name: "Preview Editable source", exact: true });
    if (entry === "context" || entry === "file-preview") {
      await userEvent.click(thumbnail, { button: "right" });
      await userEvent.click(
        page.getByRole("menuitem", { name: "Open in file preview", exact: true }),
      );
      await vi.waitFor(() => {
        const panel = useRightPanelStore.getState().byThreadKey[scopedThreadKey(target)];
        const surface = panel?.surfaces.find((entry) => entry.id === panel.activeSurfaceId);
        expect(surface?.kind).toBe("file");
        expect(surface && "image" in surface ? surface.image?.name : undefined).toBe(
          "Editable source",
        );
      });
      await expect
        .element(page.getByRole("button", { name: "Fit image", exact: true }))
        .toBeVisible();
      if (entry === "file-preview") {
        await userEvent.click(page.getByRole("button", { name: "Edit image", exact: true }));
      } else {
        await act(() => useRightPanelStore.getState().close(target));
        await userEvent.click(thumbnail, { button: "right" });
        await userEvent.click(page.getByRole("menuitem", { name: "Edit image", exact: true }));
      }
    } else {
      await userEvent.click(thumbnail);
      await userEvent.click(page.getByRole("button", { name: "Edit image", exact: true }));
    }
    await expect
      .element(page.getByRole("application", { name: "Editable annotations" }))
      .toBeVisible();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Edit instructions", exact: true }),
      "Make this image blue",
    );
    using _uploads = acceptAttachmentUploads();
    const before = dispatchedCommands().length;
    await userEvent.click(page.getByRole("button", { name: "Add edit request", exact: true }));
    await vi.waitFor(() => expect(store.getComposerDraft(target)?.images).toHaveLength(2));
    expect(store.getComposerDraft(target)?.prompt).toContain("Keep my draft");
    expect(store.getComposerDraft(target)?.prompt).toContain("Make this image blue");
    expect(store.getComposerDraft(target)?.images.map((image) => image.name)).toEqual([
      "Editable source-original.png",
      "Editable source-guidance.png",
    ]);
    expect(dispatchedCommands()).toHaveLength(before);
    await expect
      .element(page.getByRole("textbox", { name: "Edit instructions", exact: true }))
      .not.toBeInTheDocument();
  },
);

it("opens conversation images when individual sources are unavailable", async () => {
  class GalleryReadError extends Schema.TaggedError<GalleryReadError>()("GalleryReadError", {
    message: Schema.String,
  }) {}
  const style = document.createElement("style");
  style.textContent = appStyles;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const seed = threadWithHistory("missing-image-gallery", 1);
  const thread = {
    ...seed,
    items: seed.items.map((item) =>
      item.type === "user_message"
        ? {
            ...item,
            attachments: [
              {
                type: "image" as const,
                id: "gallery-missing",
                name: "missing-attachment.png",
                mimeType: "image/png",
                sizeBytes: PNG.length,
              },
              {
                type: "image" as const,
                id: "gallery-invalid",
                name: "invalid-url.png",
                mimeType: "image/png",
                sizeBytes: PNG.length,
              },
              {
                type: "image" as const,
                id: "gallery-kept",
                name: "kept.png",
                mimeType: "image/png",
                sizeBytes: PNG.length,
              },
            ],
          }
        : item.type === "assistant_message"
          ? { ...item, text: "A missing image.\n\n![missing](./missing.png)" }
          : item,
    ),
  };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  using _assets = answerRpc(
    WS_METHODS.assetsCreateUrl,
    ({ resource }: { resource: { _tag: string; attachmentId?: string } }) =>
      resource._tag === "media-file" || resource.attachmentId === "gallery-missing"
        ? Effect.fail(new GalleryReadError({ message: "Image no longer exists" }))
        : Effect.succeed({
            relativeUrl:
              resource.attachmentId === "gallery-invalid" ? "http://[" : "/api/assets/fake",
            expiresAt: 4_102_444_800_000,
          }),
  );
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using toast = vi.spyOn(toastManager, "add");
  const images = page.getByRole("button", { name: "Conversation images", exact: true });
  await expect.element(images).toBeEnabled();
  await userEvent.click(images);
  await expect.element(page.getByRole("button", { name: "Open image 1, kept.png" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Open image.*(?:missing|invalid)/ }))
    .not.toBeInTheDocument();
  expect(
    toast.mock.calls.filter(([entry]) => entry.title === "Unable to open conversation images"),
  ).toEqual([]);
});

it("leaves Images available on the new thread and drops a stale gallery load failure", async () => {
  class GalleryReadError extends Schema.TaggedError<GalleryReadError>()("GalleryReadError", {
    message: Schema.String,
  }) {}
  const style = document.createElement("style");
  style.textContent = appStyles;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const seed = threadWithHistory("stale-image-gallery", 1);
  const first = {
    ...seed,
    items: seed.items.map((item) =>
      item.type === "assistant_message"
        ? { ...item, text: "An image for the gallery.\n\n![image](./asset.png)" }
        : item,
    ),
  };
  const second = threadWithHistory("current-image-gallery", 1);
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  let finished = () => {};
  const completion = new Promise<void>((resolve) => {
    finished = resolve;
  });
  using held = holdRpc(
    WS_METHODS.assetsCreateUrl,
    Effect.fail(new GalleryReadError({ message: "Old image read failed" })).pipe(
      Effect.ensuring(Effect.sync(finished)),
    ),
  );
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using toast = vi.spyOn(toastManager, "add");
  const images = page.getByRole("button", { name: "Conversation images", exact: true });
  await expect.element(images).toBeEnabled();
  await userEvent.click(images);
  await expect.element(images).toBeDisabled();
  await vi.waitFor(() => expect(held.calls.length).toBeGreaterThan(0));
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${second.id}` });
  await expect.element(page.getByText("Answer 0 for current-image-gallery.")).toBeVisible();
  await expect.element(images).toBeEnabled();
  await act(async () => {
    held.release();
    await completion;
  });
  await userEvent.click(images);
  await expect.element(page.getByText("No images in this conversation yet.")).toBeVisible();
  expect(
    toast.mock.calls.filter(([entry]) => entry.title === "Unable to open conversation images"),
  ).toEqual([]);
  await userEvent.click(page.getByRole("button", { name: "Back", exact: true }));
});

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a machine chip stashed in one thread restores with its machine in another", async () => {
  const other = threadWithHistory("thread-stash-restore", 1);
  const asking = threadWithQuestion("thread-stash-question", "Which file should change?");
  using _environment = installFakeEnvironment([other, asking]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-stash-machine");
  const machine = environmentContextRecord(EnvironmentId.make("environment-build"), "Build box");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-stash-machine"),
  });
  drafts.setPrompt(draftId, "Deploy on ");
  drafts.addEnvironmentContexts(draftId, [machine]);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const pressStashShortcut = async () => {
    await userEvent.click(editor);
    await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  };
  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  // A draft can't stash until the shell snapshot lists its project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await pressStashShortcut();
  await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toHaveLength(1));

  // An answer carries no machines, so an open question refuses the restore and keeps the entry.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${asking.id}` });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);

  await router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` });
  await expect.element(page.getByText("Answer 0 for thread-stash-restore.")).toBeVisible();
  await pressStashShortcut();

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, other.id))
      ?.environmentContexts,
  ).toEqual([machine]);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.environmentContexts ?? [],
  ).toEqual([]);
});

it("a question that opens while a stashed file is checked keeps a machine stash", async () => {
  const thread = threadWithHistory("thread-stash-late-question", 1);
  const asking = threadWithQuestion("thread-stash-late-question", "Which file should change?");
  const [request] = asking.runtimeRequests ?? [];
  const question = asking.items.at(-1);
  if (!request || !question) throw new Error("threadWithQuestion has no question");
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  usePromptStashStore.getState().stashEntry({
    id: "stash-late-question",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "Deploy on ",
    attachments: [],
    files: [
      {
        id: "file-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        attachmentId: "attachment-notes",
        environmentId: ENVIRONMENT_ID,
      },
    ],
    droppedImageNames: [],
    records: [environmentContextRecord(EnvironmentId.make("environment-build"), "Build box")],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-stash-late-question.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));

  // The question opens while the restore still waits on the server's file check.
  await vi.waitFor(() => expect(hasPendingAssetUrl()).toBe(true));
  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: question });
  await emitThreadEvent(thread.id, { type: "runtime-request.updated", payload: request });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await answerAssetUrls();

  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);
  usePromptStashStore.getState().takeEntry("stash-late-question");
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("an interrupted image-only first send of a new thread says it may not have been sent", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-image-only-interrupted");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-image-only-interrupted"),
    });
  // A dropped connection interrupts a new thread's launch, which is not resent.
  using launch = holdRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, Effect.interrupt);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _uploads = acceptAttachmentUploads();
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  // The send needs the project, which arrives with the shell snapshot.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launch.calls).toHaveLength(1));
  await userEvent.keyboard("next draft");
  await expect.element(editor).toHaveTextContent("next draft");
  launch.release();

  await expect.element(page.getByText("Message may not have been sent")).toBeVisible();
  await expect.element(editor).toHaveTextContent("next draft");
  // With no text there is nothing to copy.
  expect(page.getByText("Copy message", { exact: true }).query()).toBeNull();
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});

it("a stashed prompt ending in a file chip restores with the chip", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-28338");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-28338"),
  });
  drafts.setPrompt(draftId, "Check [package.json](package.json) ");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const chip = page.getByRole("button", { name: "Preview package.json" });
  await expect.element(chip).toBeVisible();
  // The stash shortcut is a no-op until the shell snapshot lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await expect.element(chip).not.toBeInTheDocument();
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Check"));
  expect(editor.element().textContent).not.toContain("[package.json](package.json)");
  await expect.element(chip).toBeVisible();
});

it("a rejected send leaves the timeline when a new draft was typed meanwhile", async () => {
  const thread = threadWithHistory("rejected-send", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Failed prompt{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  await expect.element(page.getByText("Failed prompt")).toBeVisible();
  await userEvent.keyboard("Next draft");

  await rejectPendingCommand("Attachment 'sample.png' cannot be sent.");

  await expect.element(page.getByText("Attachment 'sample.png' cannot be sent.")).toBeVisible();
  await expect.element(page.getByText("Failed prompt")).not.toBeInTheDocument();
  expect(editor.element().textContent).toContain("Next draft");
});

it("Enter on an empty prompt resumes an interrupted thread", async () => {
  const history = threadWithHistory("interrupted", 1);
  const interruptedRun = { ...history.runs[0]!, status: "interrupted" as const };
  const thread = { ...history, runs: [interruptedRun] };
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByRole("button", { name: "Resume thread" })).toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ manualContinuationOfRunId: interruptedRun.id }),
    ),
  );
});

it("opening a thread or returning to the window on a touch tablet does not focus the composer", async () => {
  const realMatchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));
  const first = threadWithHistory("thread-29469-a", 1);
  const second = threadWithHistory("thread-29469-b", 1);
  using _environment = installFakeEnvironment([first, second]);
  // iPad Pro 11 in landscape: the desktop layout, above max-sm.
  await page.viewport(1194, 834);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  await expect.element(page.getByText(`Answer 0 for ${first.id}.`)).toBeVisible();

  // Fake frames hold the next thread entry's focus frame until the test advances it.
  using _timers = fakeTimers();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: second.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${second.id}.`)).toBeVisible();
  vi.advanceTimersToNextFrame();
  // Focusing the editor raises the on-screen keyboard, which shrinks the page on iPadOS.
  expect(document.activeElement).not.toBe(composer.element());

  // ChatView waits two frames after window focus before refocusing the composer.
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(document.activeElement).not.toBe(composer.element());
});

it("a mounted thread view lets go of the thread structures it has replaced", async () => {
  // Items are shared with the fixture, so a reopen's snapshot also carries the earlier updates.
  const history = threadWithHistory("updated", 3);
  const items = [...history.items];
  const updated = { ...history, items };
  const other = threadWithHistory("other", 3);
  using _environment = installFakeEnvironment([updated, other]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const open = async (threadId: ThreadId, text: string) => {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId },
      }),
    );
    await expect.element(page.getByText(text).first()).toBeVisible();
  };
  const structureAtom = environmentThreadDetails.quietThreadAtom(
    scopeThreadRef(ENVIRONMENT_ID, updated.id),
  );

  // Each round, a new answer arrives while the thread is shown, then the user switches away.
  const shown: Array<WeakRef<object>> = [];
  await open(other.id, "Answer 2 for other.");
  for (let round = 0; round < 6; round++) {
    await open(updated.id, round === 0 ? "Answer 2 for updated." : `Update ${round - 1}.`);
    const update = assistantItem(
      updated.id,
      RunId.make("updated-run-2"),
      `updated-update-${round}`,
      6 + round,
      `Update ${round}.`,
    );
    items.push(update);
    await act(() => emitThreadEvent(updated.id, { type: "turn-item.updated", payload: update }));
    await expect.element(page.getByText(`Update ${round}.`)).toBeVisible();
    shown.push(new WeakRef(appAtomRegistry.get(structureAtom)!.projection));
    await open(other.id, "Answer 2 for other.");
  }
  await cdp().send("HeapProfiler.collectGarbage");

  // The thread keeps its latest structure, and the timeline may remember the one before it.
  const kept = shown.slice(0, -2).flatMap((structure, round) => (structure.deref() ? [round] : []));
  expect(kept).toEqual([]);
});

it("a shortcut conditioned on rightPanelOpen sees the thread's open right panel", async () => {
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-panel-shortcut", 1);
  const keybindings = mergeWithDefaultKeybindings(
    compileResolvedKeybindingsConfig([
      { key: "ctrl+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
      { key: "ctrl+t", command: "rightPanel.toggle", when: "!rightPanelOpen" },
    ]),
  );
  using _environment = installFakeEnvironment([thread], {
    keybindings,
  });
  // The config stream outlives a mounted app, so reread this fixture's custom bindings.
  appAtomRegistry.refresh(
    serverEnvironment.configProjection({ environmentId: ENVIRONMENT_ID, input: {} }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await vi.waitFor(() =>
    expect(
      appAtomRegistry.get(serverEnvironment.configValueAtom(ENVIRONMENT_ID))?.keybindings,
    ).toEqual(keybindings),
  );
  const composer = page.getByTestId("composer-editor");
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.getByRole("button", { name: /^Files/ }).click();
  await composer.click();
  await userEvent.keyboard("{Control>}t{/Control}");
  await expect.element(page.getByRole("menuitem", { name: /Files/ })).toBeVisible();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
});

it("selecting a side-chat tab focuses that side chat's composer", async () => {
  const parent = threadWithHistory("focus-parent", 1);
  // The shell loaded by the file's first test stays; a family read serves side chats added later.
  const sideChat = (name: string) => ({
    ...threadWithHistory(name, 1),
    sideChatOf: parent.id,
    olderSettled: true as const,
  });
  const side = sideChat("focus-side");
  const otherSide = sideChat("focus-other-side");
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([parent, side, otherSide]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  useRightPanelStore.getState().openSideChat(parentRef, otherSide.id);
  useRightPanelStore.getState().openSideChat(parentRef, side.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
  const mainEditor = screen.getByRole("textbox", { name: `Message ${parent.title}`, exact: true });
  const sideEditor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
  await expect.element(sideEditor).toBeVisible();
  await userEvent.click(mainEditor);
  await userEvent.keyboard("main draft");

  await userEvent.click(screen.getByRole("button", { name: otherSide.title, exact: true }));
  const otherEditor = screen.getByRole("textbox", {
    name: `Message ${otherSide.title}`,
    exact: true,
  });
  await expect.element(otherEditor).toHaveFocus();
  await userEvent.keyboard("other draft");
  await expect.element(otherEditor).toHaveTextContent("other draft");

  await userEvent.click(screen.getByRole("button", { name: side.title, exact: true }));
  await expect.element(sideEditor).toHaveFocus();
  await expect.element(mainEditor).toHaveTextContent("main draft");
});
