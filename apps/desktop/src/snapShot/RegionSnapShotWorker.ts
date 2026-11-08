// Isolate native screenshot crashes and stalls in a Node-mode child.
import type { RegionSnapShotRequest, RegionSnapShotResult } from "./RegionSnapShot.ts";
import { encodeRegionSnapShot } from "./encodeRegionSnapShot.ts";

process.once("disconnect", () => process.exit(0));

async function capture() {
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { readonly default?: typeof imported }).default ?? imported;
  process.send?.("ready");
  const request = await new Promise<RegionSnapShotRequest>((resolve) => {
    process.once("message", resolve);
  });
  const shot = await xa11y.screenshot({ region: request.region });
  const encoded = await encodeRegionSnapShot(shot, request.maxSize);
  const result: RegionSnapShotResult = {
    type: "result",
    width: encoded.width,
    height: encoded.height,
    png: encoded.png.toString("base64"),
  };
  process.send?.(result);
}

void capture().catch((error: unknown) =>
  process.send?.({
    type: "error",
    message: error instanceof Error ? error.message : "Windows window capture failed.",
  } satisfies RegionSnapShotResult),
);
