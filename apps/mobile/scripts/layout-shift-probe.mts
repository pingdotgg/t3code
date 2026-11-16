// Finds layout shifts in a screen recording: frames where the content moved a few points
// instead of fading or appearing. Usage:
//   node apps/mobile/scripts/layout-shift-probe.mts <video.mp4> [--top 100] [--bottom 140] [--sheet out.png]
// Exits 1 when it finds a shift. Needs ffmpeg on PATH.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const WIDTH = 402;
const HEIGHT = 874;
const MAX_OFFSET = 40;
const COLUMN_STEP = 3;
// A frame pair below this mean difference is the same picture.
const STATIC_THRESHOLD = 0.4;
// A shift must explain most of the difference between two frames.
const SHIFT_RATIO = 0.35;

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    top: { type: "string", default: "100" },
    bottom: { type: "string", default: "140" },
    sheet: { type: "string" },
  },
});
const video = positionals[0];
if (!video) {
  console.error(
    "Usage: layout-shift-probe.mts <video.mp4> [--top n] [--bottom n] [--sheet out.png]",
  );
  process.exit(2);
}
const top = Number(values.top);
const bottom = HEIGHT - Number(values.bottom);

const fps = (() => {
  const rate = NodeChildProcess.execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "csv=p=0",
      video,
    ],
    { encoding: "utf8" },
  ).trim();
  const [numerator = 30, denominator = 1] = rate.split("/").map(Number);
  return numerator / denominator;
})();

const raw = NodeChildProcess.execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    `scale=${WIDTH}:${HEIGHT}`,
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "-",
  ],
  { maxBuffer: 1 << 30 },
);
const frameSize = WIDTH * HEIGHT;
const frameCount = Math.floor(raw.length / frameSize);

// Mean absolute difference between frame `a` and frame `b` moved by (dx, dy), over the feed area.
function difference(a: number, b: number, dx: number, dy: number) {
  let total = 0;
  let count = 0;
  for (let y = Math.max(top, top + dy); y < Math.min(bottom, bottom + dy); y += 2) {
    for (let x = Math.max(0, dx); x < Math.min(WIDTH, WIDTH + dx); x += COLUMN_STEP) {
      const before = raw[a * frameSize + (y - dy) * WIDTH + (x - dx)] ?? 0;
      const after = raw[b * frameSize + y * WIDTH + x] ?? 0;
      total += Math.abs(before - after);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

interface Shift {
  readonly frame: number;
  readonly seconds: number;
  readonly dx: number;
  readonly dy: number;
}

const found: Shift[] = [];
for (let frame = 1; frame < frameCount; frame += 1) {
  const still = difference(frame - 1, frame, 0, 0);
  if (still < STATIC_THRESHOLD) continue;
  let best = { score: still, dx: 0, dy: 0 };
  for (let offset = -MAX_OFFSET; offset <= MAX_OFFSET; offset += 1) {
    if (offset === 0) continue;
    const vertical = difference(frame - 1, frame, 0, offset);
    if (vertical < best.score) best = { score: vertical, dx: 0, dy: offset };
    const horizontal = difference(frame - 1, frame, offset, 0);
    if (horizontal < best.score) best = { score: horizontal, dx: offset, dy: 0 };
  }
  if (best.score < still * SHIFT_RATIO) {
    found.push({ frame, seconds: frame / fps, dx: best.dx, dy: best.dy });
  }
}

// A navigation push slides the whole screen sideways through several busy frames. That is
// motion, not a shift. A real horizontal shift is one jump between still frames.
const BUSY_THRESHOLD = 2;
const isSlide = (shift: Shift) => {
  if (shift.dx === 0) return false;
  let busy = 0;
  for (let frame = shift.frame - 8; frame <= shift.frame + 3; frame += 1) {
    if (frame === shift.frame || frame < 1 || frame >= frameCount) continue;
    if (difference(frame - 1, frame, 0, 0) > BUSY_THRESHOLD) busy += 1;
  }
  return busy >= 2;
};
// An animated scroll or fold moves the feed the same way through three or more frames in a row.
// A layout shift is one or two frames.
const MIN_ANIMATION_FRAMES = 3;
const isAnimationStep = (shift: Shift) => {
  if (shift.dy === 0) return false;
  const sameRun = (frame: number) =>
    found.some((other) => other.frame === frame && Math.sign(other.dy) === Math.sign(shift.dy));
  let start = shift.frame;
  while (sameRun(start - 1)) start -= 1;
  let end = shift.frame;
  while (sameRun(end + 1)) end += 1;
  return end - start + 1 >= MIN_ANIMATION_FRAMES;
};
const shifts = found.filter((shift) => !isSlide(shift) && !isAnimationStep(shift));

for (const shift of shifts) {
  console.log(
    `shift at ${shift.seconds.toFixed(3)}s (frame ${shift.frame}): dx=${shift.dx}pt dy=${shift.dy}pt`,
  );
}
console.log(`${shifts.length} shift frame(s) in ${frameCount} frames`);

const first = shifts[0];
if (values.sheet && first) {
  const start = Math.max(0, first.frame - 3);
  NodeChildProcess.execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    video,
    "-vf",
    `select='between(n,${start},${start + 7})',scale=300:-1,tile=8x1:padding=4:color=red`,
    "-frames:v",
    "1",
    values.sheet,
  ]);
  console.log(`sheet: ${values.sheet}`);
}
process.exit(shifts.length > 0 ? 1 : 0);
