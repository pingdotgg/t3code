// @effect-diagnostics nodeBuiltinImport:off - Host-side video analysis shells out to ffmpeg.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import { check, type Check, type Rect } from "./checks.ts";
import { run } from "./device.ts";

/** Pixel width of an image or video, to map snapshot coordinates onto its frames. */
export async function pixelWidth(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width",
    "-of",
    "csv=p=0",
    path,
  ]);
  return Number(stdout.trim());
}

/** Downsampled grayscale crops of one region, one per video frame (or one for a PNG). */
async function grayFrames(input: string, region: Rect, scale: number): Promise<Uint8Array[]> {
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const [x, y, width, height] = [
    Math.round(region.x * scale),
    Math.round(region.y * scale),
    even(region.width * scale),
    even(region.height * scale),
  ];
  const [outWidth, outHeight] = [even(region.width / 3), even(region.height / 3)];
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input,
        // One output frame per recorded frame, so indices match select=eq(n,…) for evidence.
        "-fps_mode",
        "passthrough",
        "-vf",
        `crop=${width}:${height}:${x}:${y},scale=${outWidth}:${outHeight},format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${stderr}`)),
    );
  });
  const size = outWidth * outHeight;
  return Array.from({ length: Math.floor(bytes.length / size) }, (_, index) =>
    bytes.subarray(index * size, (index + 1) * size),
  );
}

const distance = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index]! - b[index]!);
  return sum / a.length;
};

/** How far a region has moved from its origin toward its destination look, 0 to 1. */
export interface FrameProgress {
  readonly nav: number;
  readonly chrome: number;
}

/**
 * A frame lags when the top of the screen is well into the transition while the tab bar
 * region still looks like the origin: tabs lingering over an entering thread, or a returned
 * list drawn before its tabs.
 */
export const chromeLags = (frame: FrameProgress) => frame.nav > 0.3 && frame.chrome < 0.4;
// One lagging frame is capture jitter; a regression lasts several.
const LAG_FRAME_LIMIT = 2;

const progress = (origin: number, destination: number) =>
  origin + destination === 0 ? 0 : origin / (origin + destination);

/**
 * Checks that the tab bar moves with the screen during a recorded transition. The first and
 * last frames are the before and after looks, so nothing is compared across capture sources.
 */
export async function lagCheck(
  name: string,
  input: {
    readonly video: string;
    readonly nav: Rect;
    readonly chrome: Rect;
    /** Snapshot units across the screen, to scale regions onto the video's pixels. */
    readonly viewportWidth: number;
  },
  evidence: string,
): Promise<{ check: Check; frame?: string }> {
  // A recording the device failed to export is a gap in evidence, not a lag.
  if (!(await NodeFSP.stat(input.video).catch(() => null)))
    return { check: check(name, true, "no recording; not checked") };
  const scale = (await pixelWidth(input.video)) / input.viewportWidth;
  const [navFrames, chromeFrames] = await Promise.all([
    grayFrames(input.video, input.nav, scale),
    grayFrames(input.video, input.chrome, scale),
  ]);
  const [navOrigin, navDestination] = [navFrames[0], navFrames.at(-1)];
  const [chromeOrigin, chromeDestination] = [chromeFrames[0], chromeFrames.at(-1)];
  if (!navOrigin || !navDestination || !chromeOrigin || !chromeDestination)
    throw new Error(`Could not read frames of ${input.video}.`);
  const lagging = navFrames.flatMap((nav, index) => {
    const frame = {
      nav: progress(distance(nav, navOrigin), distance(nav, navDestination)),
      chrome: progress(
        distance(chromeFrames[index]!, chromeOrigin),
        distance(chromeFrames[index]!, chromeDestination),
      ),
    };
    return chromeLags(frame) ? [index] : [];
  });
  if (lagging.length < LAG_FRAME_LIMIT)
    return { check: check(name, true, `${lagging.length} lagging video frames`) };
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    input.video,
    "-vf",
    `select=eq(n\\,${lagging[0]})`,
    "-frames:v",
    "1",
    evidence,
  ]);
  return {
    check: check(name, false, `${lagging.length} video frames (first #${lagging[0]})`),
    frame: evidence,
  };
}
