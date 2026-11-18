import { m } from "~/i18n/messages";
import { msg } from "gt-react";
interface FrameDecoder {
  readonly tracks: {
    readonly ready: Promise<void>;
    readonly selectedTrack: { readonly frameCount: number } | null;
  };
  decode(options: { frameIndex: number; completeFramesOnly: true }): Promise<{ image: VideoFrame }>;
  close(): void;
}

interface FrameDecoderConstructor {
  new (options: { data: ArrayBuffer; type: string }): FrameDecoder;
  isTypeSupported(type: string): Promise<boolean>;
}

interface AnimationFrame {
  readonly number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

interface AnimationFrameSheet {
  readonly file: File;
  readonly context: string;
  readonly frames: readonly AnimationFrame[];
}

function frameDecoderConstructor(): FrameDecoderConstructor | undefined {
  return (globalThis as typeof globalThis & { ImageDecoder?: FrameDecoderConstructor })
    .ImageDecoder;
}

export async function createAnimationFrameSheet(
  blob: Blob,
  name: string,
): Promise<AnimationFrameSheet> {
  const ImageDecoder = frameDecoderConstructor();
  if (!ImageDecoder || !(await ImageDecoder.isTypeSupported("image/gif"))) {
    throw new Error(
      m(
        msg(
          "GIF frame editing requires a browser with ImageDecoder support, such as Chrome or the T3 desktop app.",
        ),
      ),
    );
  }
  if (blob.size > 32 * 1024 * 1024)
    throw new Error(m(msg("GIF frame editing supports images up to 32 MB.")));
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: "image/gif" });
  try {
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (count < 1 || count > 64) {
      throw new Error(m(msg("GIF frame editing supports animations with 1–64 frames.")));
    }
    const first = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const sourceWidth = first.image.displayWidth;
    const sourceHeight = first.image.displayHeight;
    first.image.close();
    if (sourceWidth < 1 || sourceHeight < 1 || sourceWidth * sourceHeight > 64_000_000) {
      throw new Error(m(msg("This GIF has unsupported frame dimensions.")));
    }
    if (sourceWidth * sourceHeight * count > 64_000_000) {
      throw new Error(
        m(
          msg(
            "This GIF is too large to edit as a frame sheet. Use fewer frames or smaller images.",
          ),
        ),
      );
    }
    const scale = Math.min(1, 384 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const tileWidth = Math.max(128, width + 16);
    const tileHeight = height + 40;
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const canvas = document.createElement("canvas");
    canvas.width = tileWidth * columns;
    canvas.height = tileHeight * rows;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(m(msg("The browser could not prepare a GIF frame sheet.")));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "12px sans-serif";
    const frames: AnimationFrame[] = [];
    for (let index = 0; index < count; index++) {
      const { image } = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
      try {
        const x = (index % columns) * tileWidth + Math.floor((tileWidth - width) / 2);
        const y = Math.floor(index / columns) * tileHeight + 32;
        const durationMs = (image.duration ?? 0) / 1000;
        context.fillStyle = "#111111";
        context.fillText(
          `Frame ${index + 1} · ${Math.round(durationMs)} ms`,
          (index % columns) * tileWidth + 8,
          y - 12,
        );
        context.drawImage(image, x, y, width, height);
        frames.push({ number: index + 1, x, y, width, height, durationMs });
      } finally {
        image.close();
      }
    }
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error(m(msg("The GIF frame sheet could not be encoded.")))),
        "image/png",
      ),
    );
    const file = new File([png], `${name.replace(/\.gif$/i, "")}-frames.png`, {
      type: "image/png",
    });
    return {
      file,
      frames,
      context: `The attached PNG is a numbered contact sheet of all ${count} frames of ${name}. Read frames left to right, top to bottom (${columns} columns). Original frame dimensions: ${sourceWidth} × ${sourceHeight}. Frame durations in milliseconds: ${frames.map((frame) => `${frame.number}: ${Math.round(frame.durationMs)}`).join(", ")}. Use the numbered frame comments and markup as editing instructions. Preserve the original animation timing and loop when producing an edited GIF.`,
    };
  } finally {
    decoder.close();
  }
}
