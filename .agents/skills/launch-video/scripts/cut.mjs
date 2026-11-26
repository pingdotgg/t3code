// Cuts device recordings into one clip from a JSON spec (segments, cover boxes, optional
// crossfade; see SKILL.md "Mobile releases"), and prints where each segment starts in the
// output. Paths are relative to the spec file. Usage: node cut.mjs <spec.json>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const specPath = process.argv[2];
if (!specPath) throw new Error("usage: cut.mjs <spec.json>");
const base = NodePath.dirname(NodePath.resolve(specPath));
const spec = JSON.parse(NodeFS.readFileSync(specPath, "utf8"));
const fps = spec.fps ?? 30;
const fade = spec.fade ?? 0;
const [width, height] = spec.size;
const resolve = (p) => NodePath.resolve(base, p);

const sources = [...new Set(spec.segments.map((s) => s.src))];
const graph = [];
sources.forEach((src, i) => {
  const uses = spec.segments.filter((s) => s.src === src).length;
  const boxes = (spec.boxes ?? [])
    .filter((b) => b.src === src)
    .map((b) => {
      const when = b.to == null ? `gte(t,${b.from})` : `between(t,${b.from},${b.to})`;
      return `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color ?? "black"}:t=fill:enable='${when}'`;
    });
  const chain = [...boxes, `split=${uses}`].join(",");
  graph.push(`[${i}:v]${chain}${Array.from({ length: uses }, (_, k) => `[s${i}_${k}]`).join("")}`);
});

const used = new Map();
const durations = [];
spec.segments.forEach((seg, n) => {
  const i = sources.indexOf(seg.src);
  const k = used.get(i) ?? 0;
  used.set(i, k + 1);
  const speed = seg.speed ?? 1;
  durations.push((seg.to - seg.from) / speed);
  graph.push(
    `[s${i}_${k}]trim=${seg.from}:${seg.to},setpts=(PTS-STARTPTS)/${speed},fps=${fps},` +
      `scale=${width}:${height}:flags=lanczos,setsar=1,format=yuv420p,settb=1/${fps}[g${n}]`,
  );
});

const starts = [];
if (fade > 0) {
  let label = "g0";
  let offset = 0;
  starts.push(0);
  for (let n = 1; n < durations.length; n++) {
    offset += durations[n - 1] - fade;
    starts.push(offset);
    const next = n === durations.length - 1 ? "out" : `x${n}`;
    graph.push(
      `[${label}][g${n}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(4)}[${next}]`,
    );
    label = next;
  }
  if (durations.length === 1) graph.push(`[g0]null[out]`);
} else {
  let t = 0;
  for (const d of durations) {
    starts.push(t);
    t += d;
  }
  graph.push(
    `${durations.map((_, n) => `[g${n}]`).join("")}concat=n=${durations.length}:v=1:a=0[out]`,
  );
}

const out = resolve(spec.out);
NodeChildProcess.execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...sources.flatMap((src) => ["-i", resolve(src)]),
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-crf",
    "14",
    "-preset",
    "medium",
    "-r",
    String(fps),
    out,
  ],
  { stdio: "inherit" },
);
const total = Number(
  NodeChildProcess.execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
    { encoding: "utf8" },
  ),
);
console.log(`${NodePath.basename(out)} ${total.toFixed(2)}s`);
spec.segments.forEach((seg, n) =>
  console.log(
    `  ${starts[n].toFixed(2)}s  ${seg.src} ${seg.from}–${seg.to} ×${seg.speed ?? 1} (${durations[n].toFixed(2)}s)`,
  ),
);
