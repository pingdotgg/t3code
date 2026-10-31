import { expect, it } from "vite-plus/test";

import { importPastedComposerText } from "./composerInlineTokenPaste";

it("imports CRLF and CR clipboard text with LF line breaks", () => {
  const clipboardData = {
    getData: (type: string) => (type === "text/plain" ? "x\r\n\r\ny\rz" : ""),
  };
  expect(importPastedComposerText(clipboardData, () => new Map())).toBe("x\n\ny\nz");
});
