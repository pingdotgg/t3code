// The OpenNext build copies the NFT-traced node_modules into
// `.open-next/server-functions/default/node_modules`. Under bun's isolated
// linker that tree is built from `.bun` store junctions, and the copy leaves
// them broken on Windows — esbuild's final bundle pass then fails with
// `Cannot read directory ".open-next/.../node_modules/.bun/.../react": Access
// is denied`. Skip the e2e on Windows until the copy re-materializes
// junctioned directories (upstream OpenNext has the same constraint).
import { execSync } from "node:child_process";

if (process.platform === "win32") {
  console.log(
    "fixtures/nextjs-isr e2e skipped on Windows: OpenNext build cannot traverse bun-store junctions (see scripts/e2e.mjs).",
  );
  process.exit(0);
}

// `bun run` puts the fixture's node_modules/.bin on PATH, so playwright
// resolves from the fixture (a bare `bun x playwright` can load the parent
// workspace's copy and die with "Requiring @playwright/test second time").
execSync("bun run test:e2e", { stdio: "inherit" });
