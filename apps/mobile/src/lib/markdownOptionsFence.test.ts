import { describe, expect, it } from "vite-plus/test";

import { stripOptionsCodeFences } from "./markdownOptionsFence";

const fence = "```";

describe("stripOptionsCodeFences", () => {
  it("removes a trailing options block", () => {
    expect(
      stripOptionsCodeFences(`Pick one.\n\n${fence}options\nShip it\nPark it\n${fence}\n`),
    ).toBe("Pick one.");
  });

  it("keeps other code blocks and text after the options block", () => {
    const markdown = `${fence}ts\nconst a = 1;\n${fence}\n\n${fence}options\nA\n${fence}\nAfter`;
    expect(stripOptionsCodeFences(markdown)).toBe(`${fence}ts\nconst a = 1;\n${fence}\n\nAfter`);
  });

  it("keeps an options fence quoted inside another fence", () => {
    const markdown = `${fence}${fence}markdown\n${fence}options\nA\n${fence}\n${fence}${fence}`;
    expect(stripOptionsCodeFences(markdown)).toBe(markdown);
  });

  it("removes an unclosed options block while the reply streams", () => {
    expect(stripOptionsCodeFences(`Done.\n\n${fence}options\nShip it`)).toBe("Done.");
    expect(stripOptionsCodeFences(`Done.\r\n\r\n  ${fence}options\r\nShip it\r\n`)).toBe("Done.");
  });

  it("accepts tilde fences", () => {
    expect(stripOptionsCodeFences("Hi\n~~~options\nA\n~~~")).toBe("Hi");
  });

  it("removes a CRLF options block", () => {
    expect(
      stripOptionsCodeFences(`Pick one.\r\n\r\n${fence}options\r\nShip it\r\n${fence}\r\n`),
    ).toBe("Pick one.");
    expect(stripOptionsCodeFences(`Pick.\r\n${fence}options \r\nA\r\n${fence}\r\nAfter`)).toBe(
      "Pick.\r\nAfter",
    );
  });

  it("removes an options block indented inside a list", () => {
    const markdown = `1. Next steps:\n\n    ${fence}options\n    Ship it\n    ${fence}\n2. Done`;
    expect(stripOptionsCodeFences(markdown)).toBe("1. Next steps:\n\n2. Done");
    expect(stripOptionsCodeFences(`Pick.\n\t${fence}options  \nA\n\t${fence}`)).toBe("Pick.");
  });

  it("closes an options block only with the same marker, like the server", () => {
    expect(
      stripOptionsCodeFences(`Pick.\n${fence}options\nA\n${fence}\`\nB\n${fence}\nAfter`),
    ).toBe("Pick.\nAfter");
  });

  it("keeps an indented options fence quoted inside another fence", () => {
    const markdown = `${fence}${fence}markdown\r\n  ${fence}options\r\n  A\r\n  ${fence}\r\n${fence}${fence}`;
    expect(stripOptionsCodeFences(markdown)).toBe(markdown);
  });

  it("keeps blocks the server won't turn into buttons", () => {
    for (const info of ["Options", "options extra", " options", "Options\r"]) {
      const markdown = `Pick.\n\n${fence}${info}\nA\n${fence}`;
      expect(stripOptionsCodeFences(markdown)).toBe(markdown);
    }
  });

  it("leaves markdown without an options block unchanged", () => {
    const markdown = `The options are below.\n\n${fence}optionsx\nA\n${fence}\n`;
    expect(stripOptionsCodeFences(markdown)).toBe(markdown);
  });
});
