import { describe, expect, it } from "vite-plus/test";

import {
  extractTerminalBufferLinks,
  terminalLinkLabel,
  TERMINAL_LINK_MAX_RESULTS,
  TERMINAL_LINK_SCAN_WINDOW_BYTES,
} from "./terminalBufferLinks";

// Claude Code's OAuth login URL shape: long enough to wrap on any phone.
const LOGIN_URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&state=Iv1supDq4Neyq6BB0nWfHhtCU9BuJqz";

function wrapToWidth(text: string, width: number): string {
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += width) {
    lines.push(text.slice(index, index + width));
  }
  return lines.join("\n");
}

describe("extractTerminalBufferLinks", () => {
  it("finds a plain URL on its own line", () => {
    const buffer =
      "Browser didn't open? Use the url below to sign in:\n\nhttps://example.com/auth\n";
    expect(extractTerminalBufferLinks(buffer)).toEqual(["https://example.com/auth"]);
  });

  it("reassembles a URL hard-wrapped to the terminal width", () => {
    const width = 48;
    const buffer = `Use the url below to sign in:\n\n${wrapToWidth(LOGIN_URL, width)}\n\nPaste code here if prompted:\n`;
    expect(extractTerminalBufferLinks(buffer)).toEqual([LOGIN_URL]);
  });

  it("does not glue following prose onto a URL that merely ends a short line", () => {
    const buffer = "Docs: https://example.com/docs\nthanks for reading\n";
    expect(extractTerminalBufferLinks(buffer)).toEqual(["https://example.com/docs"]);
  });

  it("ignores ANSI styling wrapped around and inside the URL", () => {
    const buffer =
      "\x1b[2J\x1b[H\x1b[1;34mSign in:\x1b[0m \x1b[4mhttps://example.com/\x1b[36mauth?state=abc\x1b[0m\n";
    expect(extractTerminalBufferLinks(buffer)).toEqual(["https://example.com/auth?state=abc"]);
  });

  it("reassembles a wrapped URL whose rows are painted with cursor-positioning sequences", () => {
    const width = 40;
    const rows = wrapToWidth(LOGIN_URL, width).split("\n");
    const padded = `Open the link below to continue login now`;
    const buffer = rows
      .map((row, index) => `\x1b[${index + 3};1H\x1b[K${row}`)
      .join("\r\n")
      .concat(`\r\n${padded}\r\n`);
    expect(extractTerminalBufferLinks(buffer)).toEqual([LOGIN_URL]);
  });

  it("extracts OSC 8 hyperlink targets exactly", () => {
    const buffer =
      "See \x1b]8;;https://example.com/very/long/target\x1b\\the docs\x1b]8;;\x1b\\ page\n";
    expect(extractTerminalBufferLinks(buffer)).toEqual(["https://example.com/very/long/target"]);
  });

  it("trims trailing punctuation and unbalanced closers", () => {
    const buffer = "Read https://example.com/a). Then https://example.com/b,\n";
    expect(extractTerminalBufferLinks(buffer)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
  });

  it("drops spinner-truncated prefixes of the same URL, keeping most recent first", () => {
    const buffer =
      "https://example.com/oauth?state=ab\rhttps://example.com/oauth?state=abcdef\nDone. https://example.com/next\n";
    expect(extractTerminalBufferLinks(buffer)).toEqual([
      "https://example.com/next",
      "https://example.com/oauth?state=abcdef",
    ]);
  });

  it("caps results and prefers the most recent URLs", () => {
    const buffer = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`).join(
      "\n",
    );
    const links = extractTerminalBufferLinks(buffer);
    expect(links).toHaveLength(TERMINAL_LINK_MAX_RESULTS);
    expect(links[0]).toBe("https://example.com/5");
  });

  it("ignores a URL cut in half by the scan window", () => {
    const filler = `${"x".repeat(200)}\n`;
    const buffer = `https://truncated.example.com/${"a".repeat(TERMINAL_LINK_SCAN_WINDOW_BYTES)}\n${filler.repeat(4)}https://kept.example.com/ok\n`;
    expect(extractTerminalBufferLinks(buffer)).toEqual(["https://kept.example.com/ok"]);
  });

  it("returns nothing for an empty or URL-free buffer", () => {
    expect(extractTerminalBufferLinks("")).toEqual([]);
    expect(extractTerminalBufferLinks("$ ls\nsrc package.json\n")).toEqual([]);
  });
});

describe("terminalLinkLabel", () => {
  it("shows only the host for bare origins", () => {
    expect(terminalLinkLabel("https://claude.ai")).toBe("claude.ai");
    expect(terminalLinkLabel("https://claude.ai/")).toBe("claude.ai");
  });

  it("marks URLs that carry a path or query", () => {
    expect(terminalLinkLabel(LOGIN_URL)).toBe("claude.ai/…");
  });
});
