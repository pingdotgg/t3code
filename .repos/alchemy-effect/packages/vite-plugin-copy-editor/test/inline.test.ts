import { describe, expect, test } from "bun:test";
import { annotate, inlineSource, writeInline } from "../src/source.ts";

const PAGE = `<section>
  <p class="lede" data-copy>
    Already have a Vite app? One resource in{" "}
    <code class="alc-code-inline">alchemy.run.ts</code> is the whole
    integration &mdash; see <a href="/docs" class="link">the docs</a>.
  </p>
  <h1 data-copy>Reach for <span>it</span></h1>
</section>
`;

describe("inline markdown", () => {
  test("marks convertible elements", () => {
    const out = annotate(PAGE, "f");
    expect(out).toContain('data-copy="f#0" data-copy-format="inline"');
    expect(out).toContain('data-copy="f#1">');
  });

  test("reads content as inline markdown", () => {
    expect(inlineSource(PAGE, 0).markdown).toBe(
      "Already have a Vite app? One resource in `alchemy.run.ts` is the whole integration — see [the docs](/docs).",
    );
  });

  test("deleting inline code writes plain text", () => {
    const base = inlineSource(PAGE, 0).markdown;
    const out = writeInline(PAGE, 0, {
      base,
      markdown: base.replace("`alchemy.run.ts`", "your config"),
    });
    expect(out).toContain("One resource in your config is the whole");
    expect(out).not.toContain("<code");
  });

  test("backticks become code with the page's classes", () => {
    const base = inlineSource(PAGE, 0).markdown;
    const out = writeInline(PAGE, 0, {
      base,
      markdown: `${base} Run \`alchemy dev\` and **go**.`,
    });
    expect(out).toContain(
      'Run <code class="alc-code-inline">alchemy dev</code> and <strong>go</strong>.',
    );
    expect(out).toContain('<a href="/docs" class="link">the docs</a>');
    // Round trip.
    const n = inlineSource(out, 0).markdown;
    expect(n).toBe(`${base} Run \`alchemy dev\` and **go**.`);
  });

  test("escapes template-special characters", () => {
    const base = inlineSource(PAGE, 0).markdown;
    const out = writeInline(PAGE, 0, {
      base,
      markdown: 'Use {x} & <T> it\'s "ok"',
    });
    expect(out).toContain(`Use &#123;x&#125; &amp; &lt;T&gt; it's "ok"`);
  });

  test("rejects stale edits", () => {
    expect(() =>
      writeInline(PAGE, 0, { base: "old", markdown: "new" }),
    ).toThrow(/changed/);
  });
});

test("line breaks round-trip as <br>", () => {
  const PAGE2 = `<h2 data-copy>Reach for the\n  better primitives.</h2>`;
  const base = inlineSource(PAGE2, 0).markdown;
  const out = writeInline(PAGE2, 0, {
    base,
    markdown: "Reach for the\nbetter `primitives`.",
  });
  expect(out).toContain("Reach for the<br>better <code>primitives</code>.");
  expect(inlineSource(out, 0).markdown).toBe(
    "Reach for the\nbetter `primitives`.",
  );
});
