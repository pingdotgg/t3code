/**
 * Worker-thread renderer for OG card PNGs.
 *
 * The og endpoint (src/pages/og/[...slug].png.ts) serializes each card's
 * satori element tree (plain JSON — satori only reads `type`/`props`) and
 * fans the renders out across a pool of these workers, so the ~4k
 * satori→resvg renders run on all cores instead of serially on the build's
 * main thread.
 *
 * `workerData.fonts` carries `{ name, path, weight, style }` — each worker
 * reads the font files once at startup.
 */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

const fonts = workerData.fonts.map(({ path, ...font }) => ({
  ...font,
  data: readFileSync(path),
}));

async function render({ id, tree }) {
  try {
    const svg = await satori(tree, { width: 1200, height: 630, fonts });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
      .render()
      .asPng();
    parentPort.postMessage({ id, png });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack ?? error) });
  }
}

// Serialize renders: the pool posts this worker's whole share of requests
// up front, and satori's awaits would otherwise interleave ALL of them —
// hundreds of concurrent render states per worker. That both delays the
// first result until nearly every render finishes and multiplies peak
// memory enough to OOM a 16GB CI runner. A promise chain keeps exactly
// one render in flight per worker.
let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(() => render(message));
});
