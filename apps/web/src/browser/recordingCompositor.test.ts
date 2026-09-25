import type { DesktopPreviewRecordingInput } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createRecordingCompositor, RecordingDecorations } from "./recordingCompositor";

const primaryColor = "oklch(0.65 0.2 310)";
vi.mock("./annotationTheme", () => ({
  readPreviewAnnotationTheme: () => ({ primary: "oklch(0.65 0.2 310)" }),
}));

const options = { showKeyPresses: true, showMousePresses: true, frameRate: 30 };
const pointer = (
  phase: "move" | "down" | "up" | "click",
  x = 100,
): DesktopPreviewRecordingInput => ({
  type: "pointer",
  phase,
  x,
  y: 80,
  width: 800,
  height: 600,
});
const context = () => ({
  save: vi.fn(),
  restore: vi.fn(),
  beginPath: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  ellipse: vi.fn(),
  roundRect: vi.fn(),
  fillText: vi.fn(),
  drawImage: vi.fn(),
  measureText: () => ({ width: 40 }),
  globalAlpha: 1,
  strokeStyle: "",
  fillStyle: "",
});

describe("recording decorations", () => {
  it("keeps rings aligned through dragging and stops following the cursor after release", () => {
    const decorations = new RecordingDecorations(options, primaryColor);
    const ctx = context();
    decorations.apply(pointer("down"), 0);
    decorations.apply(pointer("move", 120), 10);
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 1600, 1200, 10);
    expect(ctx.ellipse.mock.calls[0]?.slice(0, 4)).toEqual([240, 160, 40, 40]);
    expect(ctx.strokeStyle).toBe(primaryColor);
    expect(ctx.fillStyle).toBe(primaryColor);
    expect(decorations.nextRedraw(10)).toBeNull();
    decorations.apply(pointer("up", 130), 20);
    decorations.apply(pointer("move", 300), 30);
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 1600, 1200, 320);
    expect(ctx.ellipse.mock.calls[1]?.slice(0, 4)).toEqual([260, 160, 50, 50]);
    ctx.ellipse.mockClear();
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 1600, 1200, 620);
    expect(ctx.ellipse).not.toHaveBeenCalled();
    expect(decorations.nextRedraw(620)).toBeNull();
  });

  it("pulses agent clicks and clears decorations on blur or navigation", () => {
    const decorations = new RecordingDecorations(options, primaryColor);
    const ctx = context();
    decorations.apply(pointer("click"), 0);
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 800, 600, 300);
    expect(ctx.ellipse).toHaveBeenCalledOnce();
    decorations.apply({ type: "clear" }, 301);
    ctx.ellipse.mockClear();
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 800, 600, 302);
    expect(ctx.ellipse).not.toHaveBeenCalled();
    expect(decorations.nextRedraw(302)).toBeNull();
  });

  it("holds shortcut badges until release, then expires them even on a static page", () => {
    const decorations = new RecordingDecorations(options, primaryColor);
    const ctx = context();
    const key = { type: "key" as const, label: "⌘C", held: true, width: 800 };
    decorations.apply(key, 0);
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 1600, 1200, 5000);
    expect(ctx.fillText.mock.calls[0]?.slice(0, 3)).toEqual(["⌘C", 800, 1098]);
    decorations.apply({ ...key, held: false }, 5000);
    expect(decorations.nextRedraw(5500)).toBe(400);
    ctx.fillText.mockClear();
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 1600, 1200, 5900);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("removes the previous key badge on password focus", () => {
    const decorations = new RecordingDecorations(options, primaryColor);
    const ctx = context();
    decorations.apply({ type: "key", label: "A", held: true, width: 800 }, 0);
    decorations.apply({ type: "key", label: null, held: true, width: 800 }, 1);
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 800, 600, 2);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("honors independent opt-in flags", () => {
    const decorations = new RecordingDecorations(
      { ...options, showMousePresses: false },
      primaryColor,
    );
    const ctx = context();
    decorations.apply(pointer("down"), 0);
    decorations.apply({ type: "key", label: "⌘C", held: true, width: 800 }, 0);
    decorations.draw(ctx as unknown as CanvasRenderingContext2D, 800, 600, 1);
    expect(ctx.ellipse).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledOnce();
  });
});

describe("detached recording compositor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps native capture when both decorations are off", async () => {
    vi.stubGlobal("document", {
      createElement: () => {
        throw new Error("must not allocate");
      },
    });
    expect(
      await createRecordingCompositor(
        {} as MediaStream,
        {
          ...options,
          showKeyPresses: false,
          showMousePresses: false,
        },
        () => {
          throw new Error("must not subscribe");
        },
      ),
    ).toBeNull();
  });

  it.each([false, true])(
    "releases the detached output on disposal or playback failure (%s)",
    async (failPlayback) => {
      const ctx = context();
      const stop = vi.fn();
      const unsubscribe = vi.fn();
      const cancelFrame = vi.fn();
      const source = {
        getVideoTracks: () => [{ getSettings: () => ({ width: 800, height: 600 }) }],
      } as unknown as MediaStream;
      const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
      const canvas = { width: 0, height: 0, getContext: () => ctx, captureStream: () => stream };
      const video = {
        muted: false,
        playsInline: false,
        srcObject: null as MediaStream | null,
        readyState: 2,
        videoWidth: 800,
        videoHeight: 600,
        pause: vi.fn(),
        play: async () => {
          if (failPlayback) throw new Error("play failed");
        },
        requestVideoFrameCallback: () => 1,
        cancelVideoFrameCallback: cancelFrame,
      };
      vi.stubGlobal("document", {
        createElement: (tag: string) => (tag === "canvas" ? canvas : video),
      });
      vi.stubGlobal("window", { clearTimeout: vi.fn(), setTimeout: vi.fn() });
      const compositor = createRecordingCompositor(source, options, () => unsubscribe);
      if (failPlayback) await expect(compositor).rejects.toThrow("play failed");
      else {
        const result = await compositor;
        expect(result?.stream).toBe(stream);
        expect(ctx.drawImage).toHaveBeenCalledOnce();
        result?.dispose();
        result?.dispose();
      }
      expect(stop).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(video.srcObject).toBeNull();
    },
  );
});
