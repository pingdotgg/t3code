/// <reference lib="dom" />
// Holds pasted-image compression open in the page, so a scenario can act while an image is
// still preparing, then tells it when every image decode, encode and read has settled.
import { expect } from "e2e";
import type { Browser } from "@e2e-dev/web";

interface CompressionHold {
  readonly release: () => void;
  released: boolean;
  compressionDecodes: number;
  inFlight: number;
}

declare global {
  interface Window {
    compressionHold?: CompressionHold;
  }
}

/** Installs the hold before the app loads; call before `t3.open`. */
export const holdImageCompression = (browser: Browser) =>
  browser.addInitScript(() => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold: CompressionHold = {
      release: () => {
        hold.released = true;
        release();
      },
      released: false,
      compressionDecodes: 0,
      inFlight: 0,
    };
    window.compressionHold = hold;
    const track = async <T>(work: () => Promise<T>) => {
      hold.inFlight++;
      try {
        return await work();
      } finally {
        hold.inFlight--;
      }
    };

    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((source: ImageBitmapSource, ...rest: [ImageBitmapOptions?]) =>
      track(async () => {
        // Only attachment compression decodes with an orientation; placeholder thumbnails do not.
        if (rest[0]?.imageOrientation === undefined) return decode(source, ...rest);
        await released;
        const bitmap = await decode(source, ...rest);
        hold.compressionDecodes++;
        return bitmap;
      })) as typeof createImageBitmap;

    const convertToBlob = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function (options) {
      return track(() => convertToBlob.call(this, options));
    };
    const readAsDataURL = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      hold.inFlight++;
      this.addEventListener("loadend", () => hold.inFlight--, { once: true });
      readAsDataURL.call(this, blob);
    };
  });

/** Pastes a PNG wider than the 2000 px attachment limit into the focused composer. */
export const pasteWideScreenshot = (browser: Browser) =>
  browser.evaluate(async () => {
    const canvas = new OffscreenCanvas(2200, 20);
    canvas.getContext("2d")!.fillRect(0, 0, 2200, 20);
    const file = new File([await canvas.convertToBlob({ type: "image/png" })], "screenshot.png", {
      type: "image/png",
    });
    const clipboardData = new DataTransfer();
    clipboardData.items.add(file);
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) throw new Error("No composer editor to paste into");
    return editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  });

/**
 * Lets the held compression finish and waits until it has. What follows the last tracked step
 * is synchronous or microtask-only, so the app has applied the result by the next evaluate.
 */
export const finishImageCompression = async (browser: Browser) => {
  await browser.evaluate(() => {
    window.compressionHold!.release();
    return null;
  });
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const hold = window.compressionHold!;
        return hold.released && hold.compressionDecodes > 0 && hold.inFlight === 0;
      }),
    )
    .toBe(true);
};
