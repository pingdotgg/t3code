import { expect, it } from "vite-plus/test";
import { stableLinearMarkdown } from "./linearMarkdown.ts";
it("keeps private attachments stable when a signed description is edited", () => {
  expect(
    stableLinearMarkdown(
      "![Proof](https://uploads.linear.app/org/file.png?signature=temporary) [Other](https://example.com/a?signature=keep)",
    ),
  ).toBe(
    "![Proof](https://uploads.linear.app/org/file.png) [Other](https://example.com/a?signature=keep)",
  );
});
