import { expect, it } from "vite-plus/test";

import { formatFileChangeLine } from "./V2ItemInspector.logic";

it("names both sides of a renamed file relative to the workspace", () => {
  expect(
    formatFileChangeLine(
      { operation: "update", path: "/repo/src/new-name.ts", oldPath: "/repo/src/old-name.ts" },
      "/repo",
    ),
  ).toBe("update repo/src/old-name.ts → repo/src/new-name.ts");
});
