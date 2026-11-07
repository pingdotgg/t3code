import { describe, expect, it } from "vite-plus/test";

import { serializeTableElementToDelimited } from "./markdown-clipboard";

function renderTable(html: string): HTMLTableElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.querySelector("table")!;
}

function exampleTable() {
  return renderTable(`
    <table>
      <thead><tr><th>Question</th><th>Owner, team</th></tr></thead>
      <tbody>
        <tr><td></td><td>Platform</td></tr>
        <tr><td>first<br>second\tthird</td><td></td></tr>
        <tr><td><img alt="Build badge" src="b.svg"></td><td>say "ok"</td></tr>
      </tbody>
    </table>`);
}

describe("serializeTableElementToDelimited", () => {
  it("keeps every cell in its column as tab-separated rows", () => {
    expect(serializeTableElementToDelimited(exampleTable(), "tsv")).toBe(
      'Question\tOwner, team\n\tPlatform\nfirst second third\t\nBuild badge\tsay "ok"',
    );
  });

  it.each(["tsv", "csv"] as const)("copies formula-leading text literally in %s", (format) => {
    const table = renderTable(
      "<table><tr><td>=1+1</td><td>+SUM(A1)</td><td>-cmd</td><td>&#64;cmd</td><td>-42</td><td>+1.5e2</td><td>-1,000</td><td>+1,234.5e2</td><td>-1,000+1</td><td>-1,00</td></tr></table>",
    );
    const separator = format === "tsv" ? "\t" : ",";
    expect(serializeTableElementToDelimited(table, format)).toBe(
      [
        "'=1+1",
        "'+SUM(A1)",
        "'-cmd",
        "'@cmd",
        "-42",
        "+1.5e2",
        ...(format === "tsv"
          ? ["-1,000", "+1,234.5e2", "'-1,000+1", "'-1,00"]
          : ['"-1,000"', '"+1,234.5e2"', '"\'-1,000+1"', '"\'-1,00"']),
      ].join(separator),
    );
  });

  it("escapes quote-leading TSV cells", () => {
    const table = renderTable('<table><tr><td>"hello"</td><td>"open</td></tr></table>');
    expect(serializeTableElementToDelimited(table, "tsv")).toBe('"""hello"""\t"""open"');
  });

  it("keeps math as TeX", () => {
    const table = renderTable(
      '<table><tr><td><span data-markdown-math="inline" data-markdown-copy="x^2">rendered math</span></td></tr></table>',
    );
    expect(serializeTableElementToDelimited(table, "tsv")).toBe("x^2");
  });

  it("quotes CSV cells that contain commas or quotes", () => {
    expect(serializeTableElementToDelimited(exampleTable(), "csv")).toBe(
      'Question,"Owner, team"\n,Platform\nfirst second third,\nBuild badge,"say ""ok"""',
    );
  });
});
