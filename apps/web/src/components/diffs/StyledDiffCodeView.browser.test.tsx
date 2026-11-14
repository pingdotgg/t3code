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
    const container = document.createElement("div");
    container.style.cssText = "display: flex; width: 800px; height: 300px;";
    await using _screen = await render(
      <StyledDiffCodeView
        viewerRef={viewerRef}
        style={{ width: "100%", height: "100%", overflow: "auto" }}
        items={[{ id: "big", type: "diff", fileDiff }]}
      />,
      { container },
    );
    const renderedItem = () => viewerRef.current?.getInstance()?.getRenderedItems()[0]?.element;
    await vi.waitFor(
      () =>
        expect(renderedItem()?.shadowRoot?.querySelectorAll("[data-line]").length).toBeGreaterThan(
          0,
        ),
      { timeout: 10_000 },
    );
    const rows = renderedItem()!.shadowRoot!.querySelectorAll("[data-line]");
    expect(rows.length).toBeLessThan(LINE_COUNT);

    renderedItem()!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, composed: true }),
    );
    const azertyQuit = new KeyboardEvent("keydown", {
      key: "q",
      code: "KeyA",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(azertyQuit);
    expect(azertyQuit.defaultPrevented).toBe(false);
    expect(copy()).toBe("");

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
