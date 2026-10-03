// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "./markdown-clipboard";

function selectBetween(start: Node, end: Node): Selection {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.childNodes.length);
  const selection = window.getSelection();
  if (!selection) throw new Error("jsdom has no selection");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("chatMarkdownClipboardPayload", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("copies a selection spanning table rows as rows, even though the range omits the table", () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Question</th><th>Owner</th></tr></thead>
        <tbody><tr><td>Loader URL?</td><td>Platform</td></tr></tbody>
      </table>`;
    const cells = document.querySelectorAll("th, td");
    const selection = selectBetween(cells[0]!, cells[3]!);

    expect(chatMarkdownClipboardPayload(selection, "tsv")?.text).toBe(
      "Question\tOwner\nLoader URL?\tPlatform",
    );
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe(
      "| Question | Owner |\n| --- | --- |\n| Loader URL? | Platform |",
    );
  });

  it("keeps empty edge cells, line breaks, and image alt text inside cells", () => {
    document.body.innerHTML = `
      <p>Status</p>
      <table>
        <thead><tr><th>Question</th><th>Owner</th></tr></thead>
        <tbody>
          <tr><td></td><td>Platform</td></tr>
          <tr><td>first<br>second</td><td></td></tr>
          <tr><td><img alt="Build badge" src="b.svg"></td><td>ok</td></tr>
        </tbody>
      </table>`;
    const selection = selectBetween(document.body, document.body);

    expect(chatMarkdownClipboardPayload(selection, "tsv")?.text).toBe(
      "Status\n\nQuestion\tOwner\n\tPlatform\nfirst second\t\nBuild badge\tok",
    );
  });

  it("keeps a selection inside one cell as plain text", () => {
    document.body.innerHTML = `<table><tbody><tr><td>Platform</td></tr></tbody></table>`;
    const cell = document.querySelector("td")!;

    expect(chatMarkdownClipboardPayload(selectBetween(cell, cell), "tsv")?.text).toBe("Platform");
  });
});
