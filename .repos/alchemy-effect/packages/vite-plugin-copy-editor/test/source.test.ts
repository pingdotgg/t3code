import { describe, expect, test } from "bun:test";
import { annotate, applyEdit, strip } from "../src/source.ts";

const PAGE = `---
const title = "<not a tag>";
---
<section>
  <h1 data-copy class="hero">Reach for the better primitives.</h1>
  <p
    data-copy
    class="lede"
  >
    Already have a Vite app? One resource in{" "}
    <code>alchemy.run.ts</code> is the whole
    integration &mdash; really.
  </p>
  <p data-copy>{title}</p>
  <script>const x = "<h2 data-copy>not markup</h2>";</script>
</section>
`;

// The DOM text nodes the browser produces for each element.
const H1 = ["Reach for the better primitives."];
const LEDE = [
  "\n    Already have a Vite app? One resource in \n    ",
  "alchemy.run.ts",
  " is the whole\n    integration — really.\n  ",
];

describe("annotate", () => {
  test("stamps each data-copy with its file and index", () => {
    const out = annotate(PAGE, "src/index.astro");
    expect(out).toContain(
      '<h1 data-copy="src/index.astro#0" data-copy-format="inline" class="hero">',
    );
    expect(out).toContain('data-copy="src/index.astro#1"');
    expect(out).toContain('<p data-copy="src/index.astro#2">');
  });

  test("ignores frontmatter and script contents", () => {
    const out = annotate(PAGE, "f");
    expect(out).toContain('"<h2 data-copy>not markup</h2>"');
    expect(out).not.toContain("#3");
  });
});

describe("strip", () => {
  test("removes every data-copy attribute", () => {
    const out = strip(PAGE);
    expect(out).toContain('<h1 class="hero">');
    expect(out).toContain('<p\n    class="lede"\n  >');
    expect(out).toContain("<p>{title}</p>");
    // Script contents are left alone.
    expect(out).toContain('"<h2 data-copy>not markup</h2>"');
  });
});

describe("applyEdit", () => {
  test("rewrites a single text run", () => {
    const out = applyEdit(PAGE, {
      index: 0,
      before: H1,
      after: ["Reach for better primitives."],
    });
    expect(out).toContain(
      '<h1 data-copy class="hero">Reach for better primitives.</h1>',
    );
  });

  test("keeps line wrapping, spacers, entities, and tags outside the changed words", () => {
    const after = [...LEDE];
    after[2] = " is the entire\n    integration — really.\n  ";
    const out = applyEdit(PAGE, { index: 1, before: LEDE, after });
    expect(out).toContain(
      '    Already have a Vite app? One resource in{" "}\n    <code>alchemy.run.ts</code> is the entire\n    integration &mdash; really.',
    );
  });

  test("edits text inside nested tags", () => {
    const after = [...LEDE];
    after[1] = "alchemy.config.ts";
    const out = applyEdit(PAGE, { index: 1, before: LEDE, after });
    expect(out).toContain("<code>alchemy.config.ts</code>");
  });

  test("escapes characters that are special in templates", () => {
    const out = applyEdit(PAGE, {
      index: 0,
      before: H1,
      after: ["Use <T> & {x}"],
    });
    expect(out).toContain("Use &lt;T&gt; &amp; &#123;x&#125;</h1>");
  });

  test("deletes and inserts words", () => {
    const removed = applyEdit(PAGE, {
      index: 0,
      before: H1,
      after: ["Reach for primitives."],
    });
    expect(removed).toContain(">Reach for primitives.</h1>");
    const inserted = applyEdit(PAGE, {
      index: 0,
      before: H1,
      after: ["Reach for the very best better primitives."],
    });
    expect(inserted).toContain(
      ">Reach for the very best better primitives.</h1>",
    );
  });

  test("returns the source unchanged for whitespace-only edits", () => {
    const out = applyEdit(PAGE, {
      index: 0,
      before: H1,
      after: ["  Reach for the better   primitives. "],
    });
    expect(out).toBe(PAGE);
  });

  test("rejects stale text", () => {
    expect(() =>
      applyEdit(PAGE, { index: 0, before: ["Something else"], after: ["x"] }),
    ).toThrow(/doesn't match the source/);
  });

  test("rejects edits that change markup", () => {
    expect(() =>
      applyEdit(PAGE, { index: 1, before: LEDE, after: ["only one node"] }),
    ).toThrow(/removed or added markup/);
  });

  test("rejects elements containing expressions", () => {
    expect(() =>
      applyEdit(PAGE, { index: 2, before: ["x"], after: ["y"] }),
    ).toThrow(/expressions/);
  });
});
