import { describe, expect, it, vi } from "vite-plus/test";

import { createRecordingCompositor } from "./recordingCompositor";

const paintSource = (canvas: HTMLCanvasElement, color: string) => {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Source canvas is unavailable.");
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
};

const samplePixel = (video: HTMLVideoElement, x: number, y: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Sample canvas is unavailable.");
  context.drawImage(video, 0, 0);
  return Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
};

describe("recording compositor", () => {
  it("keeps the starting size and letterboxes a resized source", async () => {
    const source = document.createElement("canvas");
    source.width = 320;
    source.height = 180;
    paintSource(source, "#f00");
    const sourceStream = source.captureStream(30);
    const compositor = await createRecordingCompositor(
      sourceStream,
      { showKeyPresses: false, showMousePresses: false, frameRate: 30 },
      () => () => {},
    );
    const output = document.createElement("video");
    output.muted = true;
    output.srcObject = compositor.stream;
    try {
      await output.play();
      await vi.waitFor(() => {
        expect([output.videoWidth, output.videoHeight]).toEqual([320, 180]);
        expect(samplePixel(output, 160, 90)).toEqual([255, 0, 0]);
      });

      source.width = 90;
      source.height = 160;
      paintSource(source, "#0f0");

      await vi.waitFor(() => {
        paintSource(source, "#0f0");
        expect(samplePixel(output, 160, 90)).toEqual([0, 255, 0]);
      });
      expect([output.videoWidth, output.videoHeight]).toEqual([320, 180]);
      expect(samplePixel(output, 10, 90)).toEqual([0, 0, 0]);
    } finally {
      output.srcObject = null;
      compositor.dispose();
      for (const track of sourceStream.getTracks()) track.stop();
    }
  });
});
