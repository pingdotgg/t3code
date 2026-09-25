// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { test } from "vitest";
import { parseRedirects } from "../configuration/parseRedirects.ts";

test("parseRedirects should handle a single rule", ({ expect }) => {
  const input = `/a /b 301`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should ignore blank lines", ({ expect }) => {
  const input = `
/a /b 301
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b", lineNumber: 2 }],
    invalid: [],
  });
});

test("parseRedirects should trim whitespace", ({ expect }) => {
  const input = `
  /a /b 301
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b", lineNumber: 2 }],
    invalid: [],
  });
});

test("parseRedirects should ignore comments", ({ expect }) => {
  const input = `
  # This is a comment
  /a /b 301
  # And one here too.
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b", lineNumber: 3 }],
    invalid: [],
  });
});

test("parseRedirects should handle a single comment-only line", ({
  expect,
}) => {
  const input = `# This is just a comment`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [],
    invalid: [],
  });
});

test("parseRedirects should handle an indented comment-only line", ({
  expect,
}) => {
  const input = `  # indented comment`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [],
    invalid: [],
  });
});

test("parseRedirects should handle multiple consecutive comment lines", ({
  expect,
}) => {
  const input = `
# First comment
# Second comment
  # Indented comment
/a /b 301
# Comment after rule
# Another comment
/c /d
# Final comment
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      { from: "/a", status: 301, to: "/b", lineNumber: 5 },
      { from: "/c", status: 302, to: "/d", lineNumber: 8 },
    ],
    invalid: [],
  });
});

test("parseRedirects should handle a file with only comments", ({ expect }) => {
  const input = `
# This file has no redirects
# Just comments
  # Some indented
# And more comments
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [],
    invalid: [],
  });
});

test("parseRedirects should default to 302", ({ expect }) => {
  const input = `
  /a /b 302
  /c /d
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      { from: "/a", status: 302, to: "/b", lineNumber: 2 },
      { from: "/c", status: 302, to: "/d", lineNumber: 3 },
    ],
    invalid: [],
  });
});

test("parseRedirects should preserve querystrings on to", ({ expect }) => {
  const input = `
  /a /b?query=string 302
  /c?this=rejected /d 301
  /ext https://some.domain:1234/route?q=string#anchor
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      { from: "/a", status: 302, to: "/b?query=string", lineNumber: 2 },
      { from: "/c", status: 301, to: "/d", lineNumber: 3 },
      {
        from: "/ext",
        status: 302,
        to: "https://some.domain:1234/route?q=string#anchor",
        lineNumber: 4,
      },
    ],
    invalid: [],
  });
});

test("parseRedirects should preserve fragments", ({ expect }) => {
  const input = `
  /a /b#blah 302
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 302, to: "/b#blah", lineNumber: 2 }],
    invalid: [],
  });
});

test("parseRedirects should preserve fragments which contain a hash sign", ({
  expect,
}) => {
  const input = `
  /a /b##blah-1 302
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 302, to: "/b##blah-1", lineNumber: 2 }],
    invalid: [],
  });
});

test("parseRedirects should preserve fragments which contain a hash sign and are full URLs", ({
  expect,
}) => {
  const input = `
  /a https://example.com/b##blah-1 302
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      {
        from: "/a",
        status: 302,
        to: "https://example.com/b##blah-1",
        lineNumber: 2,
      },
    ],
    invalid: [],
  });
});

test("parseRedirects should accept 200 (proxying) redirects", ({ expect }) => {
  const input = `
	/a /b 200
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      {
        from: "/a",
        status: 200,
        to: "/b",
        lineNumber: 2,
      },
    ],
    invalid: [],
  });
});

test("parseRedirects should accept absolute URLs that end with index.html", ({
  expect,
}) => {
  const input = `
	/foo https://bar.com/index.html 302
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      {
        from: "/foo",
        status: 302,
        to: "https://bar.com/index.html",
        lineNumber: 2,
      },
    ],
    invalid: [],
  });
});

test("parseRedirects should accept going to absolute URLs with ports", ({
  expect,
}) => {
  const input = `
	/foo https://bar.com:123/index.html 302
	/cat https://cat.com:12345 302
	/dog https://dog.com:12345
	`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      {
        from: "/foo",
        status: 302,
        to: "https://bar.com:123/index.html",
        lineNumber: 2,
      },
      {
        from: "/cat",
        status: 302,
        to: "https://cat.com:12345/",
        lineNumber: 3,
      },
      {
        from: "/dog",
        status: 302,
        to: "https://dog.com:12345/",
        lineNumber: 4,
      },
    ],
    invalid: [],
  });
});

test("parseRedirects should accept relative URLs that don't point to .html files", ({
  expect,
}) => {
  const input = `
	/* /foo 200
`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      {
        from: "/*",
        status: 200,
        to: "/foo",
        lineNumber: 2,
      },
    ],
    invalid: [],
  });
});

test("parseRedirects should support inline comments", ({ expect }) => {
  const input = `/a /b 301 # redirect a to b`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should support inline comments without status code", ({
  expect,
}) => {
  const input = `/a /b # redirect with default status`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 302, to: "/b", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should support inline comments after URL fragments", ({
  expect,
}) => {
  const input = `/a /b#section 301 # redirect to section`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b#section", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should support inline comments without space after hash", ({
  expect,
}) => {
  const input = `/a /b 301 #no space comment`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 301, to: "/b", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should support multiple rules with inline comments", ({
  expect,
}) => {
  const input = `
    /a /b 301 # first rule
    /c /d # second rule with default status
    # full line comment
    /e /f 307 # third rule
  `;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      { from: "/a", status: 301, to: "/b", lineNumber: 2 },
      { from: "/c", status: 302, to: "/d", lineNumber: 3 },
      { from: "/e", status: 307, to: "/f", lineNumber: 5 },
    ],
    invalid: [],
  });
});

test("parseRedirects should support inline comments with absolute URLs containing fragments", ({
  expect,
}) => {
  const input = `/a https://x.com/b#c # comment`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [
      { from: "/a", status: 302, to: "https://x.com/b#c", lineNumber: 1 },
    ],
    invalid: [],
  });
});

test("parseRedirects should support empty inline comments (just hash)", ({
  expect,
}) => {
  const input = `/a /b #`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 302, to: "/b", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should support inline comments with multiple hashes in URL fragment", ({
  expect,
}) => {
  const input = `/a /b##anchor # comment`;
  const result = parseRedirects(input);
  expect(result).toEqual({
    rules: [{ from: "/a", status: 302, to: "/b##anchor", lineNumber: 1 }],
    invalid: [],
  });
});

test("parseRedirects should support custom limits", ({ expect }) => {
  const aaa = Array(1001).fill("a").join("");
  const bbb = Array(1001).fill("b").join("");
  const huge_line = `/${aaa} /${bbb} 301`;
  let input = `
    # Valid entry
    /a /b
    # Jumbo comment line OK, ignored as normal
    ${Array(1001).fill("#").join("")}
    # Huge path names rejected
    ${huge_line}
  `;
  let result = parseRedirects(input, { maxLineLength: 3000 });
  expect(result).toEqual({
    rules: [
      { from: "/a", status: 302, to: "/b", lineNumber: 3 },
      { from: `/${aaa}`, status: 301, to: `/${bbb}`, lineNumber: 7 },
    ],
    invalid: [],
  });

  input = `
    # COMMENTS DON'T COUNT TOWARDS TOTAL VALID RULES
    ${Array(150)
      .fill(undefined)
      .map((_, i) => `/a/${i}/* /b/${i}/:splat`)
      .join("\n")}
    # BUT DO GET COUNTED AS TOTAL LINES SKIPPED
  `;
  result = parseRedirects(input, { maxDynamicRules: 200 });
  expect(result.rules.length).toBe(150);
  expect(result.invalid.length).toBe(0);

  input = `
	  # COMMENTS DON'T COUNT TOWARDS TOTAL VALID RULES
	  ${Array(2050)
      .fill(undefined)
      .map((_, i) => `/a/${i} /b/${i}`)
      .join("\n")}
	  # BUT DO GET COUNTED AS TOTAL LINES SKIPPED
	`;
  result = parseRedirects(input, { maxStaticRules: 3000 });
  expect(result.rules.length).toBe(2050);
  expect(result.invalid.length).toBe(0);

  input = `
	  # COMMENTS DON'T COUNT TOWARDS TOTAL VALID RULES
	  ${Array(2050)
      .fill(undefined)
      .map((_, i) => `/a/${i} /b/${i}`)
      .join("\n")}
	    ${Array(150)
        .fill(undefined)
        .map((_, i) => `/a/${i}/* /b/${i}/:splat`)
        .join("\n")}
	  # BUT DO GET COUNTED AS TOTAL LINES SKIPPED
	`;
  result = parseRedirects(input, {
    maxDynamicRules: 200,
    maxStaticRules: 3000,
  });
  expect(result.rules.length).toBe(2200);
  expect(result.invalid.length).toBe(0);
});
