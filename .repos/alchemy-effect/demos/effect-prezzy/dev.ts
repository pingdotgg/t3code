/**
 * `pnpm dev`: the fast loop for designing the slideshow.
 *
 * - The live presenter (http://localhost:5199, live/) plays the real Remotion
 *   compositions step by step, like the tcut presenter, and hot-reloads when
 *   a component in remotion/ changes.
 * - intro/watch.ts rebuilds the intro whenever intro/steps.ts or a snippet
 *   changes; the presenter reloads the data and stays on the same step.
 *
 * Extra arguments go to Vite, e.g. `pnpm dev --port 5200 --open`.
 * `pnpm studio` still opens Remotion Studio for frame-by-frame work.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const dir = import.meta.dirname;
const bin = path.join(dir, "node_modules", ".bin");
const children = [
  spawn(process.execPath, [path.join(dir, "intro", "watch.ts")], { stdio: "inherit" }),
  spawn(path.join(bin, "vite"), ["--config", "live/vite.config.ts", ...process.argv.slice(2)], {
    cwd: dir,
    stdio: "inherit",
  }),
];
const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
