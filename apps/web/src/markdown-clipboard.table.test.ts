// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { serializeTableElementToDelimited } from "./markdown-clipboard";

function renderTable(html: string): HTMLTableElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.querySelector("table")!;
}

describe("serializeTableElementToDelimited", () => {
  const table = renderTable(`
    <table>
      <thead><tr><th>Question</th><th>Owner, team</th></tr></thead>
      <tbody>
        <tr><td></td><td>Platform</td></tr>
        <tr><td>first<br>second\tthird</td><td></td></tr>
        <tr><td><img alt="Build badge" src="b.svg"></td><td>say "ok"</td></tr>
      </tbody>
    </table>`);

  it("keeps every cell in its column as tab-separated rows", () => {
    expect(serializeTableElementToDelimited(table, "tsv")).toBe(
      'Question\tOwner, team\n\tPlatform\nfirst second third\t\nBuild badge\tsay "ok"',
    );
  });

  it("quotes CSV cells that contain commas or quotes", () => {
    expect(serializeTableElementToDelimited(table, "csv")).toBe(
      'Question,"Owner, team"\n,Platform\nfirst second third,\nBuild badge,"say ""ok"""',
    );
  });
});
