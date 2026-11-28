import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Playwright's pinned revision is often not downloaded; any cached Chromium renders the same CSS.
export const findChrome = (chromium) => {
  if (process.env.CHROME) return process.env.CHROME;
  const pinned = chromium.executablePath();
  if (NodeFS.existsSync(pinned)) return pinned;
  const caches = [".cache/ms-playwright", "Library/Caches/ms-playwright"]
    .map((d) => NodePath.join(NodeOS.homedir(), d))
    .filter(NodeFS.existsSync);
  const builds = caches
    .flatMap((cache) =>
      NodeFS.readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .map((d) => ({ cache, d, rev: Number(d.split("-")[1]) })),
    )
    .sort((a, b) => b.rev - a.rev);
  const candidates = builds.flatMap(({ cache, d }) => [
    NodePath.join(cache, d, "chrome-linux64/chrome"),
    NodePath.join(cache, d, "chrome-linux/chrome"),
    NodePath.join(cache, d, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"),
    NodePath.join(cache, d, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
  ]);
  const found = candidates.find(NodeFS.existsSync);
  if (!found) {
    console.error(
      "No Chromium found. Set CHROME=/path/to/chrome or run `vp exec playwright install chromium` in apps/web.",
    );
    process.exit(1);
  }
  return found;
};
