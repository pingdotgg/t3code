/**
 * Rebuilds out/capture/intro/intro.json whenever intro/steps.ts, a snippet,
 * or the shared intro types change. Remotion Studio's `intro-live`
 * composition picks up each rebuild without a reload. Started by `pnpm dev`.
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";

const dir = import.meta.dirname;
let running = false;
let again = false;

const build = () => {
  if (running) {
    again = true;
    return;
  }
  running = true;
  const started = Date.now();
  // Both decks, one after the other: they share the snippet type-check cache.
  const child = spawn(
    "sh",
    [
      "-c",
      `"${process.execPath}" "${path.join(dir, "build.ts")}" intro && "${process.execPath}" "${path.join(dir, "build.ts")}" loop`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("exit", (code) => {
    running = false;
    const took = ((Date.now() - started) / 1000).toFixed(1);
    if (code === 0) console.log(`✔ intro rebuilt (${took}s)`);
    else console.error(`✘ intro build failed (${took}s)\n${output.trim()}`);
    if (again) {
      again = false;
      build();
    }
  });
};

let timer: NodeJS.Timeout | undefined;
const schedule = (file: string | null) => {
  if (file && !/\.(ts|tsx|json)$/.test(file)) return;
  clearTimeout(timer);
  timer = setTimeout(build, 150);
};

watch(dir, { recursive: true }, (_, file) => {
  if (
    file &&
    file.startsWith(`snippets${path.sep}`) === false &&
    file !== "steps.ts" &&
    file !== "loop.ts"
  )
    return;
  schedule(file);
});
watch(path.join(dir, "..", "shared"), (_, file) => schedule(file));
console.log("● watching intro/steps.ts, intro/loop.ts and intro/snippets");
build();
