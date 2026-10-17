import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  isTerminalUrl,
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

  it("classifies uppercase schemes as URLs at activation time too", () => {
    expect(isTerminalUrl("HTTPS://example.com/docs")).toBe(true);
    expect(isTerminalUrl("Http://example.com")).toBe(true);
    expect(isTerminalUrl("src/components/main.ts")).toBe(false);
    expect(isTerminalUrl("httpsdocs/readme.md")).toBe(false);
  });

  it("finds URLs regardless of scheme casing", () => {
    expect(extractTerminalLinks("open HTTPS://example.com/docs")).toEqual([
      {
        kind: "url",
        text: "HTTPS://example.com/docs",
        start: 5,
        end: 29,
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

  it("keeps a trailing colon on URLs", () => {
    expect(extractTerminalLinks("GET https://example.test/items/foo:")).toEqual([
      { kind: "url", text: "https://example.test/items/foo:", start: 4, end: 35 },
    ]);
  });

  it.each([
    ["./main.go:10:5: undefined: x", "./main.go:10:5"],
    ["/home/dev/app/src/main.c:10:5: error: expected ';'", "/home/dev/app/src/main.c:10:5"],
    ["C:\\dev\\app\\src\\main.c:10:5: error: expected ';'", "C:\\dev\\app\\src\\main.c:10:5"],
    ["wrote ./out/report.txt:", "./out/report.txt"],
  ])("drops the colon that ends a compiler diagnostic location in %s", (line, text) => {
    const start = line.indexOf(text);
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start, end: start + text.length },
    ]);
  });

  it.each([
    " GET /api/trpc/post.list,user.me?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D 200 in 35ms",
    "GET /api/users?id=42 200",
    "GET /api/users?=42 200",
    "GET /api/search?&q=term 200",
    "proxying api/trpc/post.list?batch=1 to the backend",
  ])("skips request routes carrying a query string in %s", (line) => {
    expect(extractTerminalLinks(line)).toEqual([]);
  });

  it("keeps a URL with a query string as a URL link", () => {
    const line = "open https://example.com/api/trpc/post.list?batch=1";
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "url", text: "https://example.com/api/trpc/post.list?batch=1", start: 5, end: 51 },
    ]);
  });

  it("still treats a bare route without a query string as a path", () => {
    // Without a query string a route is indistinguishable from a file such as `post.list`.
    expect(extractTerminalLinks("GET /api/trpc/post.list 200")).toEqual([
      { kind: "path", text: "/api/trpc/post.list", start: 4, end: 23 },
    ]);
  });

  it.each([
    ["src/main.ts:12", "src/main.ts:12"],
    ["/Users/me/project/file.ts", "/Users/me/project/file.ts"],
    ["~/project/file", "~/project/file"],
    ["./a/b", "./a/b"],
    ["C:\\repo\\file.ts", "C:\\repo\\file.ts"],
    ["tail -f /tmp/foo.log", "/tmp/foo.log"],
    ["see /var/log/x", "/var/log/x"],
    ["/app/bin/server:3:7", "/app/bin/server:3:7"],
    ["did you mean src/main.ts?", "src/main.ts"],
  ])("keeps detecting the real path in %s", (line, text) => {
    const start = line.indexOf(text);
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start, end: start + text.length },
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

  it("keeps the line and column of a compiler diagnostic", () => {
    const [link] = extractTerminalLinks("/Users/julius/project/main.c:10:5: error: expected ';'");
    expect(resolvePathLinkTarget(link?.text ?? "", "/Users/julius/project")).toBe(
      "/Users/julius/project/main.c:10:5",
    );
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
