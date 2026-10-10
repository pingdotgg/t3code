import { expect, it, vi } from "vite-plus/test";
import { createCanvasFrameSink } from "./frame.ts";

it("retains a borrowed frame at its native size before notifying the viewer", () => {
  const drawImage = vi.fn();
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => ({ drawImage }),
  } as unknown as HTMLCanvasElement;
  const source = {} as CanvasImageSource;
  const notify = vi.fn(() => {
    expect(canvas.width).toBe(1170);
    expect(canvas.height).toBe(2532);
    expect(drawImage).toHaveBeenLastCalledWith(source, 0, 0, 1170, 2532);
  });
  createCanvasFrameSink(canvas, notify).present(source, 1170, 2532);
  expect(notify).toHaveBeenCalledOnce();
});

it("reports when a canvas cannot present a frame", () => {
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
  const notify = vi.fn();
  expect(createCanvasFrameSink(canvas, notify).present({} as CanvasImageSource, 1170, 2532)).toBe(
    false,
  );
  expect(notify).not.toHaveBeenCalled();
});
