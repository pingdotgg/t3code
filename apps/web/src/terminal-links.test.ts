import { describe, expect, it } from "vitest";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

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

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });
});

describe("resolveWrappedTerminalLinkRange", () => {
  it("maps wrapped URL matches back to the correct buffer rows", () => {
    const prefix = "see ";
    const firstSegment = `${prefix}https://example.com/a`;
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
    ];
    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine).not.toBeNull();
    if (!wrappedLine) {
      throw new Error("Expected wrapped terminal line to be present.");
    }

    const [match] = extractTerminalLinks(wrappedLine.text);
    expect(match).toEqual({
      kind: "url",
      text: "https://example.com/a/bc?x=1",
      start: prefix.length,
      end: firstSegment.length + secondSegment.length,
    });
    if (!match) {
      throw new Error("Expected wrapped URL match to be present.");
    }

    const range = resolveWrappedTerminalLinkRange(wrappedLine, match);

    expect(range).toEqual({
      start: { x: prefix.length + 1, y: 2 },
      end: { x: secondSegment.length, y: 3 },
    });
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 2)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 3)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 4)).toBe(false);
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

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
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
