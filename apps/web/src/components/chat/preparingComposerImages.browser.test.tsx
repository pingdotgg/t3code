import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { createStore, type StoreApi, useStore } from "zustand";

import { act, render } from "../../../test/render";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import {
  addPreparingComposerImages,
  cancelHeldComposerSend,
  cancelPreparingComposerImages,
  holdComposerSend,
  joinPreparedImagesToDraft,
  removePreparingComposerImages,
  useSubmitAfterPreparingImages,
} from "./preparingComposerImages";

type QueueSubmit = ReturnType<typeof useSubmitAfterPreparingImages>;

type DraftImagesStore = StoreApi<{ readonly ids: ReadonlyArray<string> }>;

function createDraftImagesStore(): DraftImagesStore {
  return createStore(() => ({ ids: [] }));
}

// Mirrors ChatComposer: the send reads draft images that a later effect syncs from the store.
function Probe(props: {
  targetKey: string;
  draftImagesStore: DraftImagesStore;
  onReady: (queue: QueueSubmit) => void;
  onCommit?: (images: ReadonlyArray<string>) => void;
  blocked?: boolean;
}) {
  const queue = useSubmitAfterPreparingImages(props.targetKey, props.blocked);
  const draftImages = useStore(props.draftImagesStore, (state) => state.ids);
  const { onCommit } = props;
  useEffect(() => {
    onCommit?.(draftImages);
  }, [onCommit, draftImages]);
  props.onReady(queue);
  return null;
}

function preparingImage(id: string) {
  return { id, name: `${id}.png`, file: new File(["png"], `${id}.png`), hidden: false };
}

it("sends after pasted images finish compressing, with the compressed image in the draft", async () => {
  const target = "submit-after-preparing";
  using _store = { [Symbol.dispose]: () => cancelPreparingComposerImages(target) };
  const draftImagesStore = createDraftImagesStore();
  let queueSubmit: QueueSubmit | undefined;
  let committedImages: ReadonlyArray<string> = [];
  const onCommit = (images: ReadonlyArray<string>) => {
    committedImages = images;
  };
  const onReady = (queue: QueueSubmit) => {
    queueSubmit = queue;
  };
  await using screen = await render(
    <Probe
      targetKey={target}
      draftImagesStore={draftImagesStore}
      onCommit={onCommit}
      onReady={onReady}
    />,
    // A bare hook probe; nothing here navigates.
    { router: false },
  );
  const submit = vi.fn(() => committedImages);

  expect(queueSubmit?.(submit)).toBe(false);

  addPreparingComposerImages(target, [preparingImage("first"), preparingImage("second")]);
  expect(queueSubmit?.(submit)).toBe(true);

  await act(() => removePreparingComposerImages(target, new Set(["first"])));
  expect(submit).not.toHaveBeenCalled();

  // Intake drops the placeholder and adds the compressed image in the same tick.
  await act(() => {
    removePreparingComposerImages(target, new Set(["second"]));
    draftImagesStore.setState({ ids: ["second"] });
  });
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.results[0]?.value).toEqual(["second"]);

  submit.mockClear();
  await act(() => addPreparingComposerImages(target, [preparingImage("uploading")]));
  expect(queueSubmit?.(submit)).toBe(true);
  await screen.rerender(
    <Probe
      targetKey={target}
      draftImagesStore={draftImagesStore}
      onCommit={onCommit}
      onReady={onReady}
      blocked
    />,
  );
  await act(() => removePreparingComposerImages(target, new Set(["uploading"])));
  expect(submit).not.toHaveBeenCalled();
  await screen.rerender(
    <Probe
      targetKey={target}
      draftImagesStore={draftImagesStore}
      onCommit={onCommit}
      onReady={onReady}
    />,
  );
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.results[0]?.value).toEqual(["second"]);
});

it("drops a waiting send when the composer moves to another draft or discards it", async () => {
  const target = "submit-after-preparing-old";
  const otherTarget = "submit-after-preparing-new";
  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(target);
      cancelPreparingComposerImages(otherTarget);
    },
  };
  const draftImagesStore = createDraftImagesStore();
  let queueSubmit: QueueSubmit | undefined;
  const onReady = (queue: QueueSubmit) => {
    queueSubmit = queue;
  };
  await using screen = await render(
    <Probe targetKey={target} draftImagesStore={draftImagesStore} onReady={onReady} />,
    {
      // A bare hook probe; nothing here navigates.
      router: false,
    },
  );
  const submit = vi.fn();
  addPreparingComposerImages(target, [preparingImage("pasted")]);
  expect(queueSubmit?.(submit)).toBe(true);

  // The other draft is still compressing too, so the switch alone must drop the send.
  addPreparingComposerImages(otherTarget, [preparingImage("other")]);
  await screen.rerender(
    <Probe targetKey={otherTarget} draftImagesStore={draftImagesStore} onReady={onReady} />,
  );
  await act(() => removePreparingComposerImages(target, new Set(["pasted"])));
  await screen.rerender(
    <Probe targetKey={target} draftImagesStore={draftImagesStore} onReady={onReady} />,
  );
  expect(submit).not.toHaveBeenCalled();

  // Discarding the draft cancels its compression, which must not release the held send.
  await act(() => addPreparingComposerImages(target, [preparingImage("discarded")]));
  expect(queueSubmit?.(submit)).toBe(true);
  await act(() => cancelPreparingComposerImages(target));
  expect(submit).not.toHaveBeenCalled();
});

it("holds a message send until its images join the draft, and cancels on edit, cancel, or new paste", async () => {
  const draftTarget = scopeThreadRef(EnvironmentId.make("environment-held"), ThreadId.make("held"));
  const target = composerTargetKey(draftTarget);
  const drafts = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(target);
      drafts.clearComposerContent(draftTarget);
    },
  };
  drafts.setPrompt(draftTarget, "check");
  expect(holdComposerSend(draftTarget, null)).toBeNull();

  // Two pastes compress separately; the first joining the draft is not an edit.
  addPreparingComposerImages(target, [preparingImage("first")]);
  addPreparingComposerImages(target, [preparingImage("second")]);
  const held = holdComposerSend(draftTarget, null);
  await expect(holdComposerSend(draftTarget, null)).resolves.toEqual({ status: "cancelled" });
  removePreparingComposerImages(target, new Set(["first"]));
  joinPreparedImagesToDraft(() => drafts.setPrompt(draftTarget, "check first"));
  removePreparingComposerImages(target, new Set(["second"]));
  await expect(held).resolves.toEqual({ status: "ready" });

  for (const cancel of [
    () => drafts.setPrompt(draftTarget, "check again"),
    () => cancelHeldComposerSend(target),
    () => addPreparingComposerImages(target, [preparingImage("added-mid-wait")]),
    () => removePreparingComposerImages(target, new Set(["later"]), { cancelSubmission: true }),
  ]) {
    addPreparingComposerImages(target, [preparingImage("later")]);
    const cancelled = holdComposerSend(draftTarget, null);
    cancel();
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    cancelPreparingComposerImages(target);
  }
});

it("keeps the draft unsent when image preparation fails", async () => {
  const target = "submit-after-failed-preparation";
  using _store = { [Symbol.dispose]: () => cancelPreparingComposerImages(target) };
  const draftImagesStore = createDraftImagesStore();
  let queueSubmit: QueueSubmit | undefined;
  await using _screen = await render(
    <Probe
      targetKey={target}
      draftImagesStore={draftImagesStore}
      onReady={(queue) => {
        queueSubmit = queue;
      }}
    />,
    // A bare hook probe; nothing here navigates.
    { router: false },
  );
  const submit = vi.fn();
  await act(() => addPreparingComposerImages(target, [preparingImage("failed")]));
  expect(queueSubmit?.(submit)).toBe(true);
  await act(() =>
    removePreparingComposerImages(target, new Set(["failed"]), { cancelSubmission: true }),
  );
  expect(submit).not.toHaveBeenCalled();
});
