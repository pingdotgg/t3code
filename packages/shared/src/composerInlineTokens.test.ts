import { describe, expect, it } from "vite-plus/test";

import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

describe("collectComposerInlineTokens", () => {
  it("collects file links, mentions, and skills with source ranges", () => {
    const text = "Use $ui and inspect [Chat.tsx](src/Chat.tsx) with @AGENTS.md please";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "skill",
        value: "ui",
        source: "$ui",
        start: 4,
        end: 7,
      },
      {
        type: "mention",
        value: "src/Chat.tsx",
        source: "[Chat.tsx](src/Chat.tsx)",
        start: 20,
        end: 44,
      },
      {
        type: "mention",
        value: "AGENTS.md",
        source: "@AGENTS.md",
        start: 50,
        end: 60,
      },
    ]);
  });

  it.each(["$", "€", "𑿝"])("collects %s skill names that begin with a digit", (prefix) => {
    expect(collectComposerInlineTokens(`Use ${prefix}2spec next`)).toEqual([
      {
        type: "skill",
        value: "2spec",
        source: `${prefix}2spec`,
        start: 4,
        end: 9 + prefix.length,
      },
    ]);
  });

  it("leaves digits-only dollar amounts and compact monetary expressions as text", () => {
    expect(collectComposerInlineTokens("I'll pay $20 tomorrow")).toEqual([]);
    expect(collectComposerInlineTokens("Budget is $1_000 total")).toEqual([]);
    expect(collectComposerInlineTokens("Budget is $20k tomorrow")).toEqual([]);
    expect(collectComposerInlineTokens("Cost is $100M total")).toEqual([]);
    expect(collectComposerInlineTokens("Limit is $1e6 here")).toEqual([]);
  });

  it("does not convert incomplete trailing tokens", () => {
    expect(collectComposerInlineTokens("Use $ui")).toEqual([]);
    expect(collectComposerInlineTokens("Inspect @AGENTS.md")).toEqual([]);
  });

  it("preserves a confirmed pill when only its trailing delimiter is removed", () => {
    const withDelimiter = "[package.json](package.json) ";
    const confirmed = collectComposerInlineTokens(withDelimiter);

    expect(
      collectComposerInlineTokens(withDelimiter.trimEnd(), { preserveTrailingFrom: confirmed }),
    ).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 0,
        end: 28,
      },
    ]);
  });

  it("does not preserve a pill after its source is edited", () => {
    const confirmed = collectComposerInlineTokens("[package.json](package.json) ");

    expect(
      collectComposerInlineTokens("[package.json](package-json)", {
        preserveTrailingFrom: confirmed,
      }),
    ).toEqual([]);
  });

  it.each(["@expo/ui", "@jane/foo.js", "@scope/pkg/sub/path"])(
    "keeps scoped package reference %s as plain text",
    (reference) => {
      expect(collectComposerInlineTokens(`Install ${reference} next`)).toEqual([]);
    },
  );

  it.each(["@namespace.foo(bar)", "@écrire(option)", "@e\u0301crire(option)"])(
    "keeps decorator call %s as plain text",
    (reference) => {
      expect(collectComposerInlineTokens(`${reference}\nclass Example {}`)).toEqual([]);
    },
  );

  it.each(['@"foo(bar)"', "[foo(bar)](foo%28bar%29)"])(
    "keeps an explicit decorator-shaped file reference as a mention: %s",
    (reference) => {
      expect(collectComposerInlineTokens(`${reference} `)).toEqual([
        {
          type: "mention",
          value: "foo(bar)",
          source: reference,
          start: 0,
          end: reference.length,
        },
      ]);
    },
  );

  it("keeps bare file mentions before whitespace-separated parentheses", () => {
    expect(collectComposerInlineTokens("Inspect @README.md (notes)")).toEqual([
      {
        type: "mention",
        value: "README.md",
        source: "@README.md",
        start: 8,
        end: 18,
      },
    ]);
  });

  it("keeps canonical file links for scoped paths as mentions", () => {
    expect(collectComposerInlineTokens("Inspect [sub](@scope/pkg/sub) next")).toEqual([
      {
        type: "mention",
        value: "@scope/pkg/sub",
        source: "[sub](@scope/pkg/sub)",
        start: 8,
        end: 29,
      },
    ]);
  });

  it("allows ambiguous scoped paths through explicit quoted mentions", () => {
    expect(collectComposerInlineTokens('Inspect @"expo/ui" next')).toEqual([
      {
        type: "mention",
        value: "expo/ui",
        source: '@"expo/ui"',
        start: 8,
        end: 18,
      },
    ]);
  });

  it("still collects a file link whose label is at the length cap", () => {
    const label = `${"a".repeat(508)}.tsx`;
    const tokens = collectComposerInlineTokens(`see [${label}](src/${label}) ok`);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.value).toBe(`src/${label}`);
  });

  it("leaves a file link past the label cap as plain text", () => {
    const label = `${"a".repeat(509)}.tsx`;
    expect(collectComposerInlineTokens(`see [${label}](src/${label}) ok`)).toEqual([]);
  });

  it("leaves a context reference link alone", () => {
    expect(
      collectComposerInlineTokens("see [checkout.png](t3-context://v1/image/ctx_abc) ok"),
    ).toEqual([]);
    expect(collectComposerInlineTokens("see ![ctx_abc](t3-context://v1/image/ctx_abc) ok")).toEqual(
      [],
    );
  });

  it("keeps skill and mention sources inside TeX out of the context chip list", () => {
    const source = "\\[\\text{use $browser and @README.md here}\\] then $real-skill ";
    expect(collectComposerInlineTokens(source).map((token) => token.source)).toEqual([
      "$real-skill",
    ]);
  });
});
