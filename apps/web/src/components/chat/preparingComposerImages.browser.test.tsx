import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import { act, render } from "../../../test/render";
import {
  addPreparingComposerImages,
  cancelPreparingComposerImages,
  removePreparingComposerImages,
  useSubmitAfterPreparingImages,
} from "./preparingComposerImages";

type QueueSubmit = ReturnType<typeof useSubmitAfterPreparingImages>;

const useDraftImages = create<{ readonly ids: ReadonlyArray<string> }>(() => ({ ids: [] }));

// Mirrors ChatComposer: the send reads draft images that a later effect syncs from the store.
function Probe(props: {
  targetKey: string;
  onReady: (queue: QueueSubmit) => void;
  onCommit?: (images: ReadonlyArray<string>) => void;
}) {
  const queue = useSubmitAfterPreparingImages(props.targetKey);
  const draftImages = useDraftImages((state) => state.ids);
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
  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(target);
      useDraftImages.setState({ ids: [] });
    },
  };
  let queueSubmit: QueueSubmit | undefined;
  let committedImages: ReadonlyArray<string> = [];
  await using _screen = await render(
    <Probe
      targetKey={target}
      onCommit={(images) => {
        committedImages = images;
      }}
      onReady={(queue) => {
        queueSubmit = queue;
      }}
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
    useDraftImages.setState({ ids: ["second"] });
  });
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.results[0]?.value).toEqual(["second"]);
});

it("drops a waiting send when the composer moves to another draft", async () => {
  const target = "submit-after-preparing-old";
  using _store = { [Symbol.dispose]: () => cancelPreparingComposerImages(target) };
  let queueSubmit: QueueSubmit | undefined;
  const onReady = (queue: QueueSubmit) => {
    queueSubmit = queue;
  };
  await using screen = await render(<Probe targetKey={target} onReady={onReady} />, {
    // A bare hook probe; nothing here navigates.
    router: false,
  });
  const submit = vi.fn();
  addPreparingComposerImages(target, [preparingImage("pasted")]);
  expect(queueSubmit?.(submit)).toBe(true);

  await screen.rerender(<Probe targetKey="submit-after-preparing-new" onReady={onReady} />);
  await act(() => removePreparingComposerImages(target, new Set(["pasted"])));
  expect(submit).not.toHaveBeenCalled();
});
