import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
/**
 * Renders the deck with Remotion and writes a presentation workspace that
 * `tcut present` opens directly:
 *
 *   out/presentation/presentation.json
 *   out/presentation/sources/<sha256>/step-<n>.mp4 + step-<n>.jpg
 *
 * A slide is one presenter step. A scene is split into its own steps (one
 * per code patch, plus the `s.step(...)` marks in the scene file); each
 * plays on one press of → and then holds.
 *
 *   pnpm render                          # everything missing, reuse the rest
 *   pnpm render 01-api title             # re-render these deck items
 *   pnpm render --deck 01-api-intro,01-api   # a presentation of just these items
 *
 * Speaker notes come from `deck.ts` and the scene files; edits made in the
 * presenter's notes panel are replaced on the next render.
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { deck } from "./deck.ts";
import { schedule } from "./remotion/scene/schedule.ts";
import { introTimeline, type IntroJson } from "./shared/intro.ts";
import { VIDEO, type SceneCapture } from "./shared/types.ts";

const root = import.meta.dirname;
const captureDir = path.join(root, "out", "capture");
const clipsDir = path.join(root, "out", "clips");
const presentationDir = path.join(root, "out", "presentation");

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { deck: { type: "string" } },
});
const rerender = new Set(positionals);
const subset = args.deck ? new Set(args.deck.split(",")) : undefined;
const items = subset ? deck.filter((item) => subset.has(item.id)) : deck;
if (items.length === 0) throw new Error(`no deck items match ${args.deck}`);

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

interface Part {
  title: string;
  notes: string;
  /** Frames `[from, to)` of the composition. */
  from: number;
  to: number;
  clip: string;
  poster: string;
}

/** The presenter steps of one deck item. */
const partsOf = async (item: (typeof deck)[number], durationInFrames: number): Promise<Part[]> => {
  const file = (k: number, ext: string) => path.join(clipsDir, `${item.id}.${k}.${ext}`);
  if (item.kind === "intro") {
    const intro = JSON.parse(
      await readFile(path.join(captureDir, "intro", "intro.json"), "utf8"),
    ) as IntroJson;
    return introTimeline(intro.steps).map((range, k) => ({
      title: intro.steps[k]!.title,
      notes: intro.steps[k]!.notes,
      ...range,
      clip: file(k, "mp4"),
      poster: file(k, "jpg"),
    }));
  }
  if (item.kind === "slide") {
    return [
      {
        title: item.title,
        notes: item.notes,
        from: 0,
        to: durationInFrames,
        clip: file(0, "mp4"),
        poster: file(0, "jpg"),
      },
    ];
  }
  const capture = JSON.parse(
    await readFile(path.join(captureDir, item.id, "scene.json"), "utf8"),
  ) as SceneCapture;
  const plan = await schedule(capture, VIDEO.fps);
  return plan.steps.map((step, k) => ({
    title: step.title,
    notes: step.notes,
    from: step.from,
    to: step.to,
    clip: file(k, "mp4"),
    poster: file(k, "jpg"),
  }));
};

console.log("● bundling the Remotion project");
const serveUrl = await bundle({
  entryPoint: path.join(root, "remotion", "index.ts"),
  publicDir: captureDir,
});

await mkdir(clipsDir, { recursive: true });
const steps = [];
let start = 0;
for (const item of items) {
  const composition = await selectComposition({ serveUrl, id: item.id, inputProps: {} });
  const parts = await partsOf(item, composition.durationInFrames);
  const missing = (await Promise.all(parts.map((p) => exists(p.clip)))).includes(false);
  if (rerender.has(item.id) || missing) {
    console.log(
      `● rendering ${item.id}: ${parts.length} step(s), ${(composition.durationInFrames / VIDEO.fps).toFixed(1)}s`,
    );
    for (const part of parts) {
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        crf: 18,
        imageFormat: "jpeg",
        jpegQuality: 95,
        frameRange: [part.from, part.to - 1],
        outputLocation: part.clip,
        inputProps: composition.props,
      });
      await renderStill({
        composition,
        serveUrl,
        frame: part.from,
        imageFormat: "jpeg",
        jpegQuality: 90,
        output: part.poster,
        inputProps: composition.props,
      });
      console.log(`  ✔ ${part.title}`);
    }
  } else {
    console.log(`● reusing ${item.id}`);
  }
  for (const part of parts) {
    const duration = (part.to - part.from) / VIDEO.fps;
    steps.push({
      id: `${item.id}.${steps.length}`,
      title: part.title,
      notes: part.notes,
      start,
      end: start + duration,
      source: part,
    });
    start += duration;
  }
}

// The workspace id fingerprints the clips, so the presenter never serves stale media.
const hash = createHash("sha256");
for (const step of steps) {
  hash.update(await readFile(step.source.clip));
  hash.update(await readFile(step.source.poster));
}
const id = hash.digest("hex");
const sources = path.join(presentationDir, "sources");
await rm(sources, { recursive: true, force: true });
await mkdir(path.join(sources, id), { recursive: true });
const manifestSteps = [];
for (const [index, step] of steps.entries()) {
  const clip = `step-${index + 1}.mp4`;
  const poster = `step-${index + 1}.jpg`;
  await cp(step.source.clip, path.join(sources, id, clip));
  await cp(step.source.poster, path.join(sources, id, poster));
  const { source: _, ...rest } = step;
  manifestSteps.push({ ...rest, clip, poster });
}
const manifest = {
  version: 1,
  id,
  title: "Alchemy",
  fps: VIDEO.fps,
  width: VIDEO.width,
  height: VIDEO.height,
  duration: start,
  steps: manifestSteps,
};
const temp = path.join(presentationDir, `presentation.${process.pid}.json`);
await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(temp, path.join(presentationDir, "presentation.json"));
console.log(`✔ ${steps.length} steps, ${start.toFixed(1)}s → out/presentation (pnpm present)`);
