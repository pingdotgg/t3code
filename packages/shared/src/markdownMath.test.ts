import type { Nodes } from "mdast";
import { describe, expect, it } from "vite-plus/test";

import { mathKind } from "./markdownMath.ts";
import { markdownMathRanges, parseMarkdownWithMath } from "./markdownMath.ts";

const parse = parseMarkdownWithMath;

function collect(node: Nodes, out: Nodes[] = []): Nodes[] {
  out.push(node);
  if ("children" in node) for (const child of node.children) collect(child, out);
  return out;
}

/** Formulas as `[kind, tex]`, in document order. */
function formulas(markdown: string) {
  return collect(parse(markdown)).flatMap((node) => {
    if (node.type === "math") return [["display", node.value]];
    if (node.type !== "inlineMath") return [];
    const className = node.data?.hProperties?.className;
    return [[mathKind(Array.isArray(className) ? className.join(" ") : undefined), node.value]];
  });
}

function text(markdown: string) {
  return collect(parse(markdown))
    .flatMap((node) => (node.type === "text" ? [node.value] : []))
    .join("");
}

describe("chat math parsing", () => {
  it("keeps GFM autolink destinations intact while restoring literal dollars", () => {
    const source = "Query www.example.com/?$select=id and $x$.";
    const link = collect(parse(source)).find((node) => node.type === "link");
    expect(link).toMatchObject({ url: "http://www.example.com/?$select=id" });
    expect(formulas(source)).toEqual([["inline", "x"]]);
  });

  it.each(["&#57344;", "&#xE000;", "&#xe000;"])(
    "preserves decoded private-use reference %s",
    (reference) => {
      const source = `${reference} [${reference}](https://example.com/?q=${reference}) $x$`;
      const nodes = collect(parse(source));
      expect(
        nodes
          .filter((node) => node.type === "text")
          .map((node) => node.value)
          .join(""),
      ).toBe("\uE000 \uE000 ");
      expect(nodes.find((node) => node.type === "link")).toMatchObject({
        url: "https://example.com/?q=\uE000",
      });
      expect(formulas(source)).toEqual([["inline", "x"]]);
    },
  );

  it.each(["\\(x\\)", "$x$", "$$x$$"])("preserves indented code containing %s", (formula) => {
    const source = `    ${formula}`;
    expect(collect(parse(source)).find((node) => node.type === "code")).toMatchObject({
      value: formula,
    });
    expect(markdownMathRanges(source)).toEqual([]);
  });

  it("parses formulas without reserving private-use characters", () => {
    const characters = Array.from({ length: 6400 }, (_, index) =>
      String.fromCharCode(0xe000 + index),
    ).join("");
    const source = "$x$ " + characters;
    expect(formulas(source)).toEqual([["inline", "x"]]);
    expect(text(source)).toBe(" " + characters);
  });

  it("only exposes closed explicit math fences to editors and native rendering", () => {
    expect(markdownMathRanges("```math\nx^2")).toEqual([]);
    expect(markdownMathRanges("```math\nx^2\n```")[0]?.tex).toBe("x^2");
    expect(markdownMathRanges("> ```math\n> x^2\n> ```")[0]?.tex).toBe("x^2");
  });
  it("reads the four delimiters models emit", () => {
    expect(formulas("Inline $x^2$ and \\(y_1\\), display $$a+b$$ and \\[c\\].")).toEqual([
      ["inline", "x^2"],
      ["inline", "y_1"],
      ["display", "a+b"],
      ["display", "c"],
    ]);
  });

  it("reads display blocks on their own lines", () => {
    expect(formulas("$$\n\\frac{a}{b}\n$$")).toEqual([["display", "\\frac{a}{b}"]]);
    expect(
      formulas("Where\n\\[\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n\\]\nholds."),
    ).toEqual([["display", "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}"]]);
  });

  it.each([" is the first formula.", ", followed by prose.", " \tthen more text."])(
    "keeps text after a same-line formula separate from later display math: %s",
    (trailing) => {
      const source = `$$a$$${trailing}\nSome prose.\n$$\nb\n$$`;
      const nodes = collect(parse(source));
      expect(
        nodes.filter((node) => node.type === "inlineMath" || node.type === "math"),
      ).toMatchObject([
        { type: "inlineMath", value: "a" },
        { type: "math", value: "b" },
      ]);
      expect(text(source)).toContain(`${trailing}\nSome prose.`);
      expect(markdownMathRanges(source).map((formula) => formula.source)).toEqual([
        "$$a$$",
        "$$\nb\n$$",
      ]);
    },
  );

  it("keeps block syntax inside display blocks as TeX", () => {
    expect(formulas("\\[\nx\n- y\n# z\n\\]\nafter")).toEqual([["display", "x\n- y\n# z"]]);
    expect(formulas("> $$\n> x\n> $$")).toEqual([["display", "x"]]);
    // Same-line content is not a fence; it stays one formula.
    expect(formulas("$$x^2\n+y^2$$")).toEqual([["display", "x^2\n+y^2"]]);
    expect(text("$$E=mc^2")).toBe("$$E=mc^2");
  });

  it("keeps prices, shell variables, and skill tokens as prose", () => {
    for (const prose of [
      "It costs $5 and $10.",
      "Budget $5-$10 per seat, or $20,000-$30,000 a year.",
      "Plans are $5/$10 monthly.",
      "Run $browser then $deploy on it.",
      "Set $HOME before running.",
    ]) {
      expect(formulas(prose), prose).toEqual([]);
      expect(text(prose), prose).toBe(prose);
    }
  });

  it("keeps prices as prose when math follows on the same line", () => {
    for (const price of ["$5-$10", "$5 and $10", "$5/$10", "$20,000-$30,000"]) {
      const source = `Price ${price} stays literal. The formula is $x_i$ and $5$.`;
      expect(formulas(source)).toEqual([
        ["inline", "x_i"],
        ["inline", "5"],
      ]);
      expect(text(source)).toBe(`Price ${price} stays literal. The formula is  and .`);
    }
  });

  it("leaves code, escapes, links, and citations alone", () => {
    for (const [markdown, rendered] of [
      ["Use `$x$` in code.", "Use  in code."],
      ["It costs $5 and $10, and `$HOME` stays code.", "It costs $5 and $10, and  stays code."],
      ["Export $PATH, then `$HOME`.", "Export $PATH, then ."],
      ["\\(a `\\)` b", "(a  b"],
      [
        "Set $TOKEN, then open [users](https://graph.microsoft.com/v1.0/users?$select=id).",
        "Set $TOKEN, then open users.",
      ],
      [
        "Set $TOKEN, then open <https://graph.microsoft.com/v1.0/users?$select=id>.",
        "Set $TOKEN, then open https://graph.microsoft.com/v1.0/users?$select=id.",
      ],
      ["```\n$x$ \\(y\\)\n```", ""],
      ["Escaped \\$x\\$ stays.", "Escaped $x$ stays."],
      ["Escaped \\\\(x\\\\) stays.", "Escaped \\(x\\) stays."],
      ["See [docs](https://example.com/\\(a\\)) here.", "See docs here."],
      ["As shown in \\[1\\] and \\[2, 3\\].", "As shown in [1] and [2, 3]."],
    ] as const) {
      expect(formulas(markdown), markdown).toEqual([]);
      expect(text(markdown), markdown).toBe(rendered);
    }
  });

  it("starts a formula right after an escaped dollar", () => {
    expect(formulas("Pay \\$$x$ now.")).toEqual([["inline", "x"]]);
  });

  it.each([
    ["$a`$HOME`", "$HOME"],
    ["\\(a`\\)`", "\\)"],
    ["\\(a\\alpha`\\)`", "\\)"],
    ["text \\[a`\\]`", "\\]"],
  ])("preserves an adjacent code span in %s", (source, code) => {
    expect(formulas(source)).toEqual([]);
    expect(collect(parse(source)).find((node) => node.type === "inlineCode")).toMatchObject({
      value: code,
    });
  });

  it.each([1, 2])("respects %i backslashes before a display fence", (count) => {
    const prefix = "a+" + "\\".repeat(count);
    for (const opening of ["$$", "$$\n"]) {
      const source = `${opening}${prefix}$$\nb\n$$`;
      expect(formulas(source)).toEqual([["display", count % 2 === 1 ? `${prefix}$$\nb` : prefix]]);
      expect(markdownMathRanges(source)[0]?.source).toBe(
        count % 2 === 1 ? source : `${opening}${prefix}$$`,
      );
    }
  });

  it("keeps TeX escapes inside formulas", () => {
    expect(formulas("Cost $a\\$b$ and \\(\\left(x\\right)\\).")).toEqual([
      ["inline", "a\\$b"],
      ["inline", "\\left(x\\right)"],
    ]);
  });

  it("keeps source offsets of the original message", () => {
    const markdown = "- [ ] check \\(x\\)\n- [x] then $y$";
    const offsets = collect(parse(markdown)).flatMap((node) =>
      node.type === "inlineMath" || node.type === "listItem"
        ? [[node.type, node.position?.start.offset]]
        : [],
    );
    expect(offsets).toEqual([
      ["listItem", 0],
      ["inlineMath", markdown.indexOf("\\(")],
      ["listItem", markdown.indexOf("- [x]")],
      ["inlineMath", markdown.indexOf("$y$")],
    ]);
  });

  it.each(["\n", "\r\n", "\r"])("keeps authored lines and UTF-16 offsets with %j", (eol) => {
    const source = `😀 \\(x${eol}+y\\)${eol}${eol}- [ ] check $z$`;
    const nodes = collect(parse(source));
    const formula = nodes.find(
      (node) => node.type === "inlineMath" && node.value === "x" + eol + "+y",
    );
    expect(formula?.position?.start).toEqual({ line: 1, column: 4, offset: 3 });
    expect(formula?.position?.end).toEqual({
      line: 2,
      column: 5,
      offset: source.indexOf(eol + eol),
    });
    expect(nodes.find((node) => node.type === "listItem")?.position?.start).toEqual({
      line: 4,
      column: 1,
      offset: source.indexOf("- [ ]"),
    });
  });

  it("shows unfinished formulas as text while a response streams", () => {
    const message = "Energy \\(E = mc^2\\) and $$\\sum_i x_i$$ done.";
    for (let end = 0; end <= message.length; end++) {
      expect(() => parse(message.slice(0, end))).not.toThrow();
    }
    expect(text("Energy \\(E = mc")).toBe("Energy (E = mc");
    expect(formulas("$$\nx^2")).toEqual([]);
    expect(formulas("\\[\nx^2\n- y")).toEqual([]);
    expect(formulas(message)).toEqual([
      ["inline", "E = mc^2"],
      ["display", "\\sum_i x_i"],
    ]);
  });
});

describe("math in GFM tables", () => {
  it("renders math in link labels while retaining dollars in their destinations", () => {
    const row = "| [norm $|x|$](https://example.com/$path) | y$ |";
    for (const source of [`${row}\n| --- | --- |`, `| First | Second |\n| --- | --- |\n${row}`]) {
      const tree = parse(source);
      const table = tree.children[0];
      expect(table?.type).toBe("table");
      if (table?.type !== "table") throw new Error("Missing table");
      expect(table.children.every((entry) => entry.children.length === 2)).toBe(true);
      expect(markdownMathRanges(source, tree).map((range) => range.tex)).toEqual(["|x|"]);
      expect(collect(tree).find((node) => node.type === "link")).toMatchObject({
        url: "https://example.com/$path",
      });
    }
  });

  it.each(["[a](https://example.com/$x)", "`$x`", '<span title="$x">a</span>'])(
    "preserves table separators after literal dollars in %s",
    (literal) => {
      const row = `| ${literal} | y$ |`;
      for (const source of [`${row}\n| --- | --- |`, `| First | Second |\n| --- | --- |\n${row}`]) {
        const tree = parse(source);
        const table = tree.children[0];
        expect(table?.type).toBe("table");
        if (table?.type !== "table") throw new Error("Missing table");
        expect(table.children.every((entry) => entry.children.length === 2)).toBe(true);
        expect(markdownMathRanges(source, tree)).toEqual([]);
        if (literal.startsWith("[a](https://example.com/$x)")) {
          expect(collect(tree).find((node) => node.type === "link")).toMatchObject({
            url: "https://example.com/$x",
          });
        }
      }
    },
  );

  it("retains multiline math after a prose pipe outside tables", () => {
    const source = "a | b: \\(x\n+y\\)";
    expect(formulas(source)).toEqual([["inline", "x\n+y"]]);
    expect(markdownMathRanges(source)).toEqual([
      expect.objectContaining({ source: "\\(x\n+y\\)", inTable: false }),
    ]);
  });
  it.each(["\\(", "\\["])("keeps table rows intact when %s closes in a later row", (opener) => {
    const closer = opener === "\\(" ? "\\)" : "\\]";
    const source = `| Name | Value |\n| --- | --- |\n| first | ${opener}x |\n| second | y${closer} |\n| valid | $|z|$ |`;
    const tree = parseMarkdownWithMath(source);
    const table = tree.children[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("Missing table");
    expect(table.children.map((row) => row.children.length)).toEqual([2, 2, 2, 2]);
    expect(
      collect(tree)
        .filter((node) => node.type === "text")
        .map((node) => node.value),
    ).toEqual([
      "Name",
      "Value",
      "first",
      opener.slice(1) + "x",
      "second",
      "y" + closer.slice(1),
      "valid",
    ]);
    expect(markdownMathRanges(source)).toEqual([
      expect.objectContaining({ source: "$|z|$", tex: "|z|" }),
    ]);
    expect(JSON.stringify(tree)).not.toMatch(/[\uE000-\uF8FF]/);
  });
  it.each(["\\(\\frac{1}{|x|}\\)", "$$|x|$$", "$|x|$"])(
    "keeps pipes inside %s in one cell and preserves source offsets",
    (formula) => {
      const source = `| Name | Value |\n| --- | --- |\n| x | ${formula} |\n\n- [ ] next`;
      const tree = parseMarkdownWithMath(source);
      const table = tree.children[0];
      expect(table?.type).toBe("table");
      if (table?.type !== "table") throw new Error("Missing table");
      expect(table.children.map((row) => row.children.length)).toEqual([2, 2]);
      expect(markdownMathRanges(source)).toEqual([
        expect.objectContaining({ source: formula, start: source.indexOf(formula) }),
      ]);
      const checkbox = collect(tree).find((node) => node.type === "listItem");
      expect(checkbox?.position?.start.offset).toBe(source.indexOf("- [ ]"));
    },
  );

  it("preserves TeX pipe commands inside and outside tables", () => {
    const source = "| Formula |\n| --- |\n| \\(\\|x\\|\\) |\n\n\\(\\|x\\|\\)";
    expect(markdownMathRanges(source).map((formula) => formula.tex)).toEqual([
      "\\|x\\|",
      "\\|x\\|",
    ]);
  });

  it("leaves code, URLs, incomplete math, and private-use text unchanged", () => {
    const source =
      "| Value | Other |\n| --- | --- |\n| `\\(a\\|b\\)` | \\(x|y\\) |\n\n\uE000\n\n[link](https://example.com/$x|y$)\n\nUnclosed \\(x|y";
    const tree = parseMarkdownWithMath(source);
    expect(markdownMathRanges(source).map((formula) => formula.tex)).toEqual(["x|y"]);
    expect(JSON.stringify(tree)).toContain("https://example.com/$x|y$");
    expect(collect(tree).find((node) => node.type === "inlineCode")).toMatchObject({
      value: "\\(a|b\\)",
    });
    expect(JSON.stringify(tree)).toContain("\uE000");
  });

  it("keeps a display equation's equality line out of Markdown headings", () => {
    const source = "\\[\na\n=\nb\n\\]";
    expect(parseMarkdownWithMath(source).children).toEqual([
      expect.objectContaining({ type: "math", value: "a\n=\nb" }),
    ]);
  });
});
