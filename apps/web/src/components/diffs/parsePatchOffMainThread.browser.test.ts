import { expect, it } from "vite-plus/test";

import { getRenderablePatch } from "~/lib/diffRendering";
import { parsePatchOffMainThread } from "./parsePatchOffMainThread";

it("parses in the worker exactly as on the main thread", async () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/b.ts",
    "@@ -0,0 +1 @@",
    "+added",
    "",
  ].join("\n");

  const [first, second] = await Promise.all([
    parsePatchOffMainThread(patch, "test"),
    parsePatchOffMainThread("", "test"),
  ]);

  expect(first).toEqual(getRenderablePatch(patch, "test", { compactPartialHunkOffsets: true }));
  expect(second).toBeNull();
});
