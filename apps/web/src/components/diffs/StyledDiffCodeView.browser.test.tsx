import type { CodeViewHandle } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { StyledDiffCodeView } from "./StyledDiffCodeView";

const LINE_COUNT = 2_000;
const lines = Array.from({ length: LINE_COUNT }, (_, index) => `line ${index + 1}`);
const fileDiff = parsePatchFiles(
  [
    "diff --git a/big.sql b/big.sql",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/big.sql",
    `@@ -0,0 +1,${LINE_COUNT} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n"),
  "big.sql",
)[0]!.files[0]!;

function copy(): string {
  const clipboardData = new DataTransfer();
  document.body.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
  );
  return clipboardData.getData("text/plain");
}

describe("StyledDiffCodeView", () => {
  it("copies every line of a file after select all, including rows the virtualizer dropped", async () => {
    const viewerRef = createRef<CodeViewHandle<undefined, undefined>>();
    await using _screen = await render(
      <StyledDiffCodeView
        viewerRef={viewerRef}
        style={{ height: 300, overflow: "auto" }}
        items={[{ id: "big", type: "diff", fileDiff }]}
      />,
    );
    const root = () => viewerRef.current?.getInstance()?.getRenderedItems()[0]?.element.shadowRoot;
    await vi.waitFor(() => expect(root()?.querySelector("[data-line]")).toBeTruthy());
    const rows = root()!.querySelectorAll("[data-line]");
    expect(rows.length).toBeLessThan(LINE_COUNT);

    rows[1]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    const selectAll = new KeyboardEvent("keydown", {
      key: "ф",
      code: "KeyA",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(selectAll);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "с", code: "KeyC", metaKey: true, bubbles: true }),
    );

    expect(selectAll.defaultPrevented).toBe(true);
    expect(copy()).toBe(lines.join("\n"));

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(copy()).toBe("");
  });
});
