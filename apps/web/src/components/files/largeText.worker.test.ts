import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { expect, it, vi } from "vite-plus/test";

import { PREVIEW_PAGE_ROWS, type TextPreviewResult } from "./largeTextProtocol";

async function openWorker(text: string) {
  const worker = new EventTarget();
  let resolvePage = (_rows: string[][]) => {};
  let pageIndex = 0;
  const loaded = Promise.withResolvers<void>();
  vi.stubGlobal(
    "self",
    Object.assign(worker, {
      postMessage: (result: TextPreviewResult) => {
        if (result.type === "error") throw new Error(result.code);
        if (result.type === "meta" && result.complete) loaded.resolve();
        if (result.type === "page" && result.index === pageIndex) resolvePage(result.rows);
      },
    }),
  );
  vi.resetModules();
  await import("./largeText.worker");
  worker.dispatchEvent(
    new MessageEvent("message", { data: { type: "open", text, delimiter: "\t" } }),
  );
  await loaded.promise;
  return (index: number) =>
    new Promise<string[][]>((resolve) => {
      pageIndex = index;
      resolvePage = resolve;
      worker.dispatchEvent(new MessageEvent("message", { data: { type: "page", index } }));
    });
}

it.each([
  ["without a file BOM", `${"a\tb\n".repeat(PREVIEW_PAGE_ROWS)}\uFEFF"kept"\tlast\n`],
  [
    "with a file BOM",
    `\uFEFF"header"\tvalue\n${"a\tb\n".repeat(PREVIEW_PAGE_ROWS - 1)}\uFEFF"kept"\tlast\n`,
  ],
])("pages a TSV %s the same way as parsing it whole", async (_name, text) => {
  try {
    const expected = parseDelimitedPreview(text, "\t").rows;
    const page = await openWorker(text);
    expect(await page(0)).toEqual(expected.slice(0, PREVIEW_PAGE_ROWS));
    expect(await page(1)).toEqual([['\uFEFF"kept"', "last"]]);
  } finally {
    vi.unstubAllGlobals();
  }
});
