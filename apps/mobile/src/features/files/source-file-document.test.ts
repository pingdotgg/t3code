import { expect, it } from "vite-plus/test";
import { prepareSourceFileDocument, selectableSourceHtml } from "./source-file-document";

it("preserves source whitespace and markup as literal selectable text", () => {
  const source = prepareSourceFileDocument(
    "\n\tlead\r\n<script>alert(1)</script> &amp; > 😀\u00a0end\n",
  );
  const html = selectableSourceHtml(source.contents, {
    foreground: "#000000",
    selection: "#3366ff",
    fontSize: 14,
    rowHeight: 24,
    wordBreak: true,
  });
  const page = new DOMParser().parseFromString(html, "text/html");

  expect(page.querySelector("script")).toBeNull();
  expect(page.body.textContent).toBe("\n\tlead\n<script>alert(1)</script> &amp; > 😀\u00a0end\n");
  expect(page.getElementById("L2")?.textContent).toBe("\tlead");
});
