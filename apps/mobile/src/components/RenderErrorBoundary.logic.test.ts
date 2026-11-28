import { expect, it } from "vite-plus/test";

import { errorDetailsPreview } from "./RenderErrorBoundary.logic";

it("previews the first line up to 300 units without splitting an emoji", () => {
  expect(errorDetailsPreview(`${"a".repeat(299)}😀 more`)).toBe("a".repeat(299));
  expect(errorDetailsPreview(`${"a".repeat(298)}😀 more`)).toBe(`${"a".repeat(298)}😀`);
  expect(errorDetailsPreview("TypeError: boom 🚀\n    at render")).toBe("TypeError: boom 🚀");
});
