import type { RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";

import type { ChatComposerHandle } from "./ChatComposer";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { render } from "../../../test/render";
import { useComposerFocus } from "./useComposerFocus";

type Focus = ReturnType<typeof useComposerFocus>;

function Probe(props: {
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly onRender: (focus: Focus) => void;
}) {
  props.onRender(useComposerFocus(props.composerRef));
  return null;
}

const handle = (focusAtEnd: () => void) => ({ focusAtEnd }) as unknown as ChatComposerHandle;

it("focuses the composer's current handle without changing identity", async () => {
  const composerRef: RefObject<ChatComposerHandle | null> = { current: null };
  const renders: Focus[] = [];
  const onRender = (focus: Focus) => renders.push(focus);
  await using screen = await render(<Probe composerRef={composerRef} onRender={onRender} />);

  const replaced = vi.fn();
  const current = vi.fn();
  composerRef.current = handle(replaced);
  // The composer replaces its handle as the thread changes, with no render here in between.
  composerRef.current = handle(current);
  renders.at(-1)!.focusComposer();
  expect(current).toHaveBeenCalledTimes(1);

  await screen.rerender(<Probe composerRef={composerRef} onRender={onRender} />);
  expect(renders.at(-1)!.focusComposer).toBe(renders[0]!.focusComposer);
  expect(renders.at(-1)!.scheduleComposerFocus).toBe(renders[0]!.scheduleComposerFocus);
  expect(replaced).not.toHaveBeenCalled();
});

it("schedules focus for the next frame unless the model picker is open by then", async () => {
  const focusAtEnd = vi.fn();
  const composerRef: RefObject<ChatComposerHandle | null> = { current: handle(focusAtEnd) };
  const renders: Focus[] = [];
  await using _screen = await render(
    <Probe composerRef={composerRef} onRender={(focus) => renders.push(focus)} />,
  );
  const { scheduleComposerFocus } = renders.at(-1)!;
  const frames: FrameRequestCallback[] = [];
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
    frames.push(frame);
    return frames.length;
  });

  scheduleComposerFocus();
  expect(focusAtEnd).not.toHaveBeenCalled();
  frames.shift()!(0);
  expect(focusAtEnd).toHaveBeenCalledTimes(1);

  scheduleComposerFocus();
  const closeModelPicker = registerModelPickerContent();
  frames.shift()!(0);
  closeModelPicker();
  expect(focusAtEnd).toHaveBeenCalledTimes(1);
});
