import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useSubmitAfterNativeImages } from "./useSubmitAfterNativeImages";

function setup() {
  const root = createRoot(document.createElement("div"));
  let queue: ReturnType<typeof useSubmitAfterNativeImages>;
  let generation = 0;
  let blocked = false;
  const onSubmit = vi.fn();
  const preparations: Array<(success: boolean) => void> = [];
  const onPasteImages = () => new Promise<boolean>((resolve) => preparations.push(resolve));
  function Probe() {
    const current = useSubmitAfterNativeImages({
      draftKey: "draft",
      readResetGeneration: () => generation,
      blocked,
      onPasteImages,
      onSubmit: (action) => {
        if (!blocked) onSubmit(action);
      },
    });
    useLayoutEffect(() => {
      queue = current;
    });
    return null;
  }
  const render = () => act(() => root.render(<Probe />));
  render();
  return {
    get queue() {
      return queue!;
    },
    onSubmit,
    setBlocked(value: boolean) {
      blocked = value;
      render();
    },
    reset() {
      generation += 1;
      render();
    },
    async finish(success: boolean) {
      await act(async () => {
        preparations.shift()!(success);
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("does not send when conversion finishes without adding an image", async () => {
  using state = setup();
  const paste = state.queue.pasteImages(["image"]);
  expect(state.queue.deferSend()).toBe(true);
  await state.finish(false);
  await paste;
  expect(state.onSubmit).not.toHaveBeenCalled();

  const first = state.queue.pasteImages(["failed"]);
  const second = state.queue.pasteImages(["successful"]);
  state.queue.deferSend();
  await state.finish(false);
  await state.finish(true);
  await Promise.all([first, second]);
  expect(state.onSubmit).not.toHaveBeenCalled();

  const retry = state.queue.pasteImages(["retry"]);
  state.queue.deferSend();
  await state.finish(true);
  await retry;
  expect(state.onSubmit).toHaveBeenCalledOnce();
});

it("does not send a replacement draft after the original draft was discarded", async () => {
  using state = setup();
  const paste = state.queue.pasteImages(["image"]);
  state.queue.deferSend();
  state.reset();
  await state.finish(true);
  await paste;
  expect(state.onSubmit).not.toHaveBeenCalled();

  const next = state.queue.pasteImages(["next"]);
  state.queue.deferSend();
  state.setBlocked(true);
  await state.finish(true);
  await next;
  state.reset();
  state.setBlocked(false);
  expect(state.onSubmit).not.toHaveBeenCalled();
});

it("waits for other attachment preparation and sends once after all images join the draft", async () => {
  using state = setup();
  const first = state.queue.pasteImages(["first"]);
  const second = state.queue.pasteImages(["second"]);
  state.queue.deferSend("queue");
  state.queue.deferSend("steer");
  await state.finish(true);
  expect(state.onSubmit).not.toHaveBeenCalled();
  state.setBlocked(true);
  await state.finish(true);
  await Promise.all([first, second]);
  expect(state.onSubmit).not.toHaveBeenCalled();
  state.setBlocked(false);
  expect(state.onSubmit).toHaveBeenCalledExactlyOnceWith("steer");
  state.setBlocked(true);
  state.setBlocked(false);
  expect(state.onSubmit).toHaveBeenCalledOnce();
});
