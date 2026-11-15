import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect } from "react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import { act, render } from "../../../test/render";
import {
  type ComposerImageAttachment,
  DraftId,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { serializeEditorDoc } from "../../composer-rich-text-doc";
import { captureComposerAttachmentInsertion } from "../composerAttachmentInsertion";
import { insertAttachmentReferencesForDraft } from "./composerAttachmentReferences";
import { getPreparingComposerImages } from "./preparingComposerImages";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";

const compression = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: compression.prepare,
}));
vi.mock("../../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

type IntakeInput = Parameters<typeof useComposerAttachmentIntake>[0];
type Intake = ReturnType<typeof useComposerAttachmentIntake>;

function Harness({ input, ready }: { input: IntakeInput; ready: (value: Intake) => void }) {
  const intake = useComposerAttachmentIntake(input);
  useEffect(() => ready(intake));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

// A clipboard image arrives as a new File named image.png on every paste.
const pastedImage = (fill = 0) =>
  new File([new Uint8Array(100).fill(fill)], "image.png", { type: "image/png" });
// Compression shrinks an image, so the draft's copy no longer matches the pasted bytes; images
// with different pixels compress to different sizes.
const compress = async (source: File) => {
  const [firstByte = 0] = new Uint8Array(await source.arrayBuffer());
  return {
    ok: true as const,
    file: new File([new Uint8Array(60 + firstByte)], "image.png", { type: "image/png" }),
    recompressed: true as const,
  };
};
const visiblePreparing = (targetKey: string) =>
  getPreparingComposerImages(targetKey).filter((image) => !image.hidden);

it("prepares a repeated paste without a tile, and still keeps a different image", async () => {
  const target = DraftId.make("intake-repeat-paste");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const firstCompression = deferred<void>();
  compression.prepare
    .mockReset()
    .mockImplementationOnce(async (file: File) => {
      await firstCompression.promise;
      return compress(file);
    })
    .mockImplementation(compress);
  const composerImagesRef = { current: [] as ComposerImageAttachment[] };
  const addImages = (images: ComposerImageAttachment[]) => {
    const ids = store.addImages(target, images);
    composerImagesRef.current =
      useComposerDraftStore.getState().getComposerDraft(target)?.images ?? [];
    return ids;
  };
  const input = {
    activeThreadId: ThreadId.make("thread"),
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: false,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: target,
    fileStagingLimit: null,
    promptRef: { current: "" },
    composerImagesRef,
    composerFilesRef: { current: [] },
    composerEditorRef: { current: null },
    isRevertingCheckpointRef: { current: false },
    setThreadError: () => {},
    countReservedAttachments: () =>
      composerImagesRef.current.length + getPreparingComposerImages(target).length,
    addComposerImage: (image) => addImages([image]),
    addComposerImagesToDraft: addImages,
    addComposerFilesToDraft: () => [],
    removeComposerImageFromDraft: () => {},
    insertAttachmentReferences: () => false,
  } satisfies IntakeInput;
  let intake!: Intake;
  await using _screen = await render(
    <Harness
      input={input}
      ready={(value) => {
        intake = value;
      }}
    />,
  );

  const first = intake.addComposerAttachments([pastedImage()]);
  const whileCompressing = intake.addComposerAttachments([pastedImage()]);
  expect(visiblePreparing(target)).toHaveLength(1);
  await act(async () => {
    firstCompression.resolve();
    await Promise.all([first, whileCompressing]);
  });

  const afterCompression = intake.addComposerAttachments([pastedImage()]);
  expect(visiblePreparing(target)).toHaveLength(0);
  await act(() => afterCompression);
  expect(composerImagesRef.current).toHaveLength(1);

  // Same name, type and size, different pixels: it compresses differently and is kept.
  const different = intake.addComposerAttachments([pastedImage(7)]);
  expect(visiblePreparing(target)).toHaveLength(0);
  await act(() => different);
  expect(composerImagesRef.current).toHaveLength(2);
});

// The thread row's discard runs after the composer left that thread; a draft session's discard
// unmounts its composer afterwards.
it.each(["thread", "session"] as const)(
  "a %s draft discarded while an image compresses stays discarded and can be restored",
  async (kind) => {
    const store = useComposerDraftStore.getState();
    const environmentId = EnvironmentId.make(`intake-discard-${kind}`);
    const threadId = ThreadId.make("thread");
    const target =
      kind === "session" ? DraftId.make("intake-discard") : scopeThreadRef(environmentId, threadId);
    if (typeof target === "string") {
      store.setProjectDraftThreadId(scopeProjectRef(environmentId, ProjectId.make("p")), target);
    }
    store.setPrompt(target, "half-written prompt");
    using _draft = {
      [Symbol.dispose]: () => {
        if (typeof target === "string") store.clearDraftThread(target);
        else store.clearComposerContent(target);
      },
    };
    const targetKey = composerTargetKey(target);

    const compressing = deferred<void>();
    const resumeCompression = deferred<void>();
    compression.prepare.mockReset().mockImplementation(async (file: File) => {
      compressing.resolve();
      await resumeCompression.promise;
      return compress(file);
    });

    const input = {
      activeThreadId: threadId,
      activePendingProgress: null,
      activePendingIsResponding: false,
      pendingUserInputs: [],
      supportsQuestionAttachments: false,
      isLiteralPendingAnswer: false,
      projectSelectionRequired: false,
      questionAttachmentTarget: null,
      attachmentTargetKey: targetKey,
      fileStagingLimit: null,
      promptRef: { current: "half-written prompt" },
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerEditorRef: { current: null },
      isRevertingCheckpointRef: { current: false },
      setThreadError: () => {},
      countReservedAttachments: () => getPreparingComposerImages(targetKey).length,
      addComposerImage: (image) => store.addImages(target, [image]),
      addComposerImagesToDraft: (images) => store.addImages(target, images),
      addComposerFilesToDraft: () => [],
      removeComposerImageFromDraft: (id) => store.removeImage(target, id),
      insertAttachmentReferences: () => false,
    } satisfies IntakeInput;
    let intake!: Intake;
    await using screen = await render(
      <Harness
        input={input}
        ready={(value) => {
          intake = value;
        }}
      />,
    );
    const attaching = intake.addComposerAttachments([pastedImage()]);
    await compressing.promise;

    if (kind === "session") {
      discardComposerDraft(target);
      await screen.unmount();
    } else {
      await screen.unmount();
      discardComposerDraft(target);
    }
    await act(async () => {
      resumeCompression.resolve();
      await attaching;
    });

    expect(getPreparingComposerImages(targetKey)).toHaveLength(0);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    const undo = vi.mocked(showThreadUndoNotice).mock.calls.at(-1)![0].undo;
    expect(AsyncResult.isSuccess(await undo())).toBe(true);
    const restored = useComposerDraftStore.getState().getComposerDraft(target);
    expect(restored?.prompt).toBe("half-written prompt");
    expect(restored?.images).toEqual([]);
  },
);

it.each(["sequential", "first-finishes-first", "second-finishes-first"] as const)(
  "successive image pastes at one caret keep their paste order (%s)",
  async (order) => {
    const target = DraftId.make(`intake-paste-order-${order}`);
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Before ");
    using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        Node.create({
          name: "composer-context-reference",
          group: "inline",
          inline: true,
          atom: true,
          addAttributes: () => ({
            kind: { default: "" },
            contextId: { default: "" },
            label: { default: "" },
            source: { default: "" },
          }),
          renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, HTMLAttributes.label],
        }),
      ],
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Before " }] }],
      },
    });
    using _editor = {
      [Symbol.dispose]: () => {
        editor.destroy();
        element.remove();
      },
    };
    editor.commands.setTextSelection(TextSelection.atEnd(editor.state.doc).from);
    const firstCompression = deferred<void>();
    const secondCompression = deferred<void>();
    const compressNamed = (gate: Promise<void>) => async (file: File) => {
      await gate;
      const result = await compress(file);
      return { ...result, file: new File([result.file], file.name, { type: "image/png" }) };
    };
    compression.prepare
      .mockReset()
      .mockImplementationOnce(compressNamed(firstCompression.promise))
      .mockImplementationOnce(compressNamed(secondCompression.promise));
    const composerImagesRef = { current: [] as ComposerImageAttachment[] };
    const addImages = (images: ComposerImageAttachment[]) => {
      const ids = store.addImages(target, images);
      composerImagesRef.current =
        useComposerDraftStore.getState().getComposerDraft(target)?.images ?? [];
      return ids;
    };
    const promptRef = { current: "Before " };
    const input = {
      activeThreadId: ThreadId.make("thread"),
      activePendingProgress: null,
      activePendingIsResponding: false,
      pendingUserInputs: [],
      supportsQuestionAttachments: false,
      isLiteralPendingAnswer: false,
      projectSelectionRequired: false,
      questionAttachmentTarget: null,
      attachmentTargetKey: target,
      fileStagingLimit: null,
      promptRef,
      composerImagesRef,
      composerFilesRef: { current: [] },
      composerEditorRef: {
        current: {
          focus: () => editor.commands.focus(),
          focusAt: () => {},
          focusAtEnd: () => {},
          readSelectionRange: () => ({ start: 7, end: 7 }),
          captureAttachmentInsertion: () => captureComposerAttachmentInsertion(editor),
          requestCitationComment: () => {},
          readSnapshot: () => ({
            value: serializeEditorDoc(editor.state.doc).value,
            cursor: 7,
            expandedCursor: 7,
            contextIds: [],
          }),
          isCaretOnVisualEdge: () => false,
        },
      },
      isRevertingCheckpointRef: { current: false },
      setThreadError: () => {},
      countReservedAttachments: () =>
        composerImagesRef.current.length + getPreparingComposerImages(target).length,
      addComposerImage: (image) => addImages([image]),
      addComposerImagesToDraft: addImages,
      addComposerFilesToDraft: () => [],
      removeComposerImageFromDraft: () => {},
      insertAttachmentReferences: (references, _selection, pending) =>
        insertAttachmentReferencesForDraft({
          target,
          liveAttachmentTargetKey: target,
          references,
          insertReferences: () => {
            const inserted = pending?.insert(references) ?? false;
            promptRef.current = serializeEditorDoc(editor.state.doc).value;
            store.setPrompt(target, promptRef.current);
            return inserted;
          },
        }),
    } satisfies IntakeInput;
    let intake!: Intake;
    await using _screen = await render(
      <Harness
        input={input}
        ready={(value) => {
          intake = value;
        }}
      />,
    );
    const firstFile = new File([new Uint8Array(100)], "first.png", { type: "image/png" });
    const secondFile = new File([new Uint8Array(100).fill(7)], "second.png", { type: "image/png" });

    const first = intake.addComposerAttachments([firstFile]);
    let second = order === "sequential" ? null : intake.addComposerAttachments([secondFile]);
    if (order === "second-finishes-first") {
      await act(async () => {
        secondCompression.resolve();
        await second;
      });
    }
    await act(async () => {
      firstCompression.resolve();
      await first;
    });
    second ??= intake.addComposerAttachments([secondFile]);
    await act(async () => {
      secondCompression.resolve();
      await second;
    });

    expect(composerImagesRef.current).toHaveLength(2);
    expect(element.textContent).toBe("Before first.png second.png ");
  },
);
