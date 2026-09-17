// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { test } from "vitest";
import { parseHeaders } from "../configuration/parseHeaders.ts";

test("parseHeaders should reject malformed initial lines", ({ expect }) => {
  const input = `
    # A single token before a path
    c
    # A header before a path
    Access-Control-Allow-Origin: *
  `;
  const result = parseHeaders(input);
  expect(result).toEqual({
    rules: [],
    invalid: [
      {
        line: "c",
        lineNumber: 3,
        message: "Expected a path beginning with at least one forward-slash",
      },
      {
        line: "Access-Control-Allow-Origin: *",
        lineNumber: 5,
        message:
          "Path should come before header (access-control-allow-origin: *)",
      },
    ],
  });
});

test("parseHeaders should reject invalid headers", ({ expect }) => {
  const input = `
    # Valid header sails through
    /a
      Name:       Value
    #
    /b
      I'm invalid!
      !x-content-type
      But: I'm okay!
      ! Content-Type: application/json
  `;
  const result = parseHeaders(input);
  expect(result).toEqual({
    rules: [
      { path: "/a", headers: { name: "Value" }, unsetHeaders: [] },
      { path: "/b", headers: { but: "I'm okay!" }, unsetHeaders: [] },
    ],
    invalid: [
      {
        line: `I'm invalid!`,
        lineNumber: 7,
        message: "Expected a colon-separated header pair (e.g. name: value)",
      },
      {
        line: "!x-content-type",
        lineNumber: 8,
        message: "Expected a colon-separated header pair (e.g. name: value)",
      },
      {
        line: `! Content-Type: application/json`,
        lineNumber: 10,
        message: "Header name cannot include spaces",
      },
    ],
  });
});

test("parseHeaders should reject lines longer than 2000 chars", ({
  expect,
}) => {
  const huge_line = `${Array(1001).fill("a").join("")}: ${Array(1001).fill("b").join("")}`;
  const input = `
    # Valid entry
    /a
      Name: Value
    # Jumbo comment line OK, ignored as normal
    ${Array(1001).fill("#").join("")}
    # Huge path names rejected
    /b
      Name: Value
      ${huge_line}
  `;
  const result = parseHeaders(input);
  expect(result).toEqual({
    rules: [
      { path: "/a", headers: { name: "Value" }, unsetHeaders: [] },
      { path: "/b", headers: { name: "Value" }, unsetHeaders: [] },
    ],
    invalid: [
      {
        message: `Ignoring line 10 as it exceeds the maximum allowed length of 2000.`,
      },
    ],
  });
});

test("parseHeaders should reject any rules after the first 100", ({
  expect,
}) => {
  const input = `
    # COMMENTS DON'T COUNT TOWARDS TOTAL VALID RULES
    ${Array(150)
      .fill(undefined)
      .map((_, i) => `/a/${i}\nx-index: ${i}`)
      .join("\n")}
    # BUT DO GET COUNTED AS TOTAL LINES SKIPPED
  `;

  expect(parseHeaders(input)).toEqual({
    rules: Array(101)
      .fill(undefined)
      .map((_, i) => ({
        path: "/a/" + i,
        headers: { "x-index": `${i}` },
        unsetHeaders: [],
      })),
    invalid: [
      {
        message: `Maximum number of rules supported is 100. Skipping remaining 100 lines of file.`,
      },
    ],
  });
});

test("parseHeaders should reject paths with multiple wildcards", ({
  expect,
}) => {
  const input = `
  # Multiple wildcards in an absolute URL
  https://*.pages.dev/*
    x-custom: value
  # Multiple wildcards in a relative path
  /blog/*/posts/*
    x-custom: value
  # Single wildcard is fine
  https://*.pages.dev/
    x-custom: value
  /blog/*
    x-custom: value
`;
  const result = parseHeaders(input);
  expect(result).toEqual({
    rules: [
      {
        path: "https://*.pages.dev/",
        headers: { "x-custom": "value" },
        unsetHeaders: [],
      },
      {
        path: "/blog/*",
        headers: { "x-custom": "value" },
        unsetHeaders: [],
      },
    ],
    invalid: [
      {
        line: "https://*.pages.dev/*",
        lineNumber: 3,
        message:
          "Only one wildcard is allowed per rule. Use a named placeholder (e.g. :project) instead. Skipping https://*.pages.dev/*.",
      },
      {
        line: "/blog/*/posts/*",
        lineNumber: 6,
        message:
          "Only one wildcard is allowed per rule. Use a named placeholder (e.g. :project) instead. Skipping /blog/*/posts/*.",
      },
    ],
  });
});

test("parseHeaders should reject paths combining wildcard with :splat placeholder", ({
  expect,
}) => {
  const input = `
  # Wildcard + :splat in an absolute URL
  https://*.pages.dev/:splat
    x-custom: value
  # Wildcard + :splat in a relative path
  /blog/*/:splat
    x-custom: value
  # Just :splat without wildcard is fine
  /blog/:splat
    x-custom: value
`;
  const result = parseHeaders(input);
  expect(result).toEqual({
    rules: [
      {
        path: "/blog/:splat",
        headers: { "x-custom": "value" },
        unsetHeaders: [],
      },
    ],
    invalid: [
      {
        line: "https://*.pages.dev/:splat",
        lineNumber: 3,
        message:
          "Cannot combine a wildcard * with a :splat placeholder because wildcards are converted to :splat at runtime. Skipping https://*.pages.dev/:splat.",
      },
      {
        line: "/blog/*/:splat",
        lineNumber: 6,
        message:
          "Cannot combine a wildcard * with a :splat placeholder because wildcards are converted to :splat at runtime. Skipping /blog/*/:splat.",
      },
    ],
  });
});

test("parseHeaders should reject malformed URLs", ({ expect }) => {
  const input = `
  # Spaces should be URI encoded
  /some page with spaces
    valid: yup
  # OK with URL escaped encoding
  /some%20page
    valid: yup
  # Unescaped URLs are handled OK by Deno, so escape & pass them through
  /://so;\`me
    valid: yup
  /nons:/&@%+~{}ense
    valid: yup
  # Absolute URLs with a non-https protocol should be rejected
  https://yeah.com
    valid: yup
  http://nah.com/blog
    invalid: things
  # Absolute URLs with a port should be rejected
  https://nah.com:8080
    invalid: also
  https://nah.com:8080/blog
    invalid: 2
  //yeah.com/blog
    valid: things
  /yeah
    valid: yup
  /yeah.com
    valid: yup
  # Anything standalone is interpreted as a invalid header pair
  nah.com
  :
  test:
`;
  const result = parseHeaders(input);
  expect(result).toEqual({
    invalid: [
      {
        line: "http://nah.com/blog",
        lineNumber: 16,
        message:
          'URLs should either be relative (e.g. begin with a forward-slash), or use HTTPS (e.g. begin with "https://").',
      },
      {
        line: "https://nah.com:8080",
        lineNumber: 19,
        message:
          "Specifying ports is not supported. Skipping absolute URL https://nah.com:8080.",
      },
      {
        line: "https://nah.com:8080/blog",
        lineNumber: 21,
        message:
          "Specifying ports is not supported. Skipping absolute URL https://nah.com:8080/blog.",
      },
      {
        line: "nah.com",
        lineNumber: 30,
        message: "Expected a colon-separated header pair (e.g. name: value)",
      },
      { line: ":", lineNumber: 31, message: "No header name specified" },
      { line: "test:", lineNumber: 32, message: "No header value specified" },
    ],
    rules: [
      {
        path: "/some%20page%20with%20spaces",
        headers: { valid: "yup" },
        unsetHeaders: [],
      },
      { path: "/some%20page", headers: { valid: "yup" }, unsetHeaders: [] },
      { path: "/://so;%60me", headers: { valid: "yup" }, unsetHeaders: [] },
      {
        path: "/nons:/&@%+~%7B%7Dense",
        headers: { valid: "yup" },
        unsetHeaders: [],
      },
      {
        path: "https://yeah.com/",
        headers: { valid: "yup" },
        unsetHeaders: [],
      },
      {
        path: "//yeah.com/blog",
        headers: { valid: "things" },
        unsetHeaders: [],
      },
      { path: "/yeah", headers: { valid: "yup" }, unsetHeaders: [] },
      { path: "/yeah.com", headers: { valid: "yup" }, unsetHeaders: [] },
    ],
  });
});
