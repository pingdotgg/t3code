// Isolate native screenshot crashes and stalls in a Node-mode child.
import type { RegionSnapShotRequest, RegionSnapShotResult } from "./RegionSnapShot.ts";
import { loadWindowsRegionCapture } from "./WindowsRegionCapture.ts";

process.once("disconnect", () => process.exit(0));

async function capture() {
  const captureRegion = await loadWindowsRegionCapture();
  process.send?.("ready");
  const request = await new Promise<RegionSnapShotRequest>((resolve) => {
    process.once("message", resolve);
  });
  const shot = captureRegion(request.region);
  const result: RegionSnapShotResult = {
    type: "result",
    width: shot.width,
    height: shot.height,
    png: shot.png.toString("base64"),
  };
  process.send?.(result);
}

void capture().catch((error: unknown) =>
  process.send?.({
    type: "error",
    message: error instanceof Error ? error.message : "Windows window capture failed.",
  } satisfies RegionSnapShotResult),
);
