import { describe, expect, it } from "vitest";

import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "./terminal-links";

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });
});
