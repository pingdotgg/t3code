import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
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
  it.each([
    String.raw`src\index.ts:12`,
    String.raw`.\src\index.ts:12:7`,
    String.raw`..\src\index.ts:12`,
    String.raw`C:\Users\Jane\project\index.ts:12`,
    String.raw`\\server\share\index.ts:12`,
  ])("finds Windows path %s", (text) => {
    const line = `error at ${text}: failed`;
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start: 9, end: 9 + text.length },
    ]);
  });

  it.each(['"', "'", "`"])("finds paths containing spaces enclosed in %s", (quote) => {
    const text = String.raw`C:\Users\Jane Doe\project\index.ts:12:7`;
    expect(extractTerminalLinks(`see ${quote}${text}${quote}.`)).toEqual([
      { kind: "path", text, start: 5, end: 5 + text.length },
    ]);
  });

  it.each([
    String.raw`src\my folder\index.ts`,
    "./my folder/index.ts",
    "/home/Jane Doe/index.ts",
    "/home/Jane Doe/file)",
    String.raw`\\server\my share\index.ts`,
  ])("keeps positions outside quotes on %s", (path) => {
    expect(extractTerminalLinks(`"${path}":12:7: error`)).toEqual([
      { kind: "path", text: `${path}:12:7`, start: 1, end: path.length + 7 },
    ]);
  });

  it("does not treat quoted prose as a path", () => {
    expect(extractTerminalLinks('error: "something went wrong"')).toEqual([]);
    expect(extractTerminalLinks('error: "something went wrong."')).toEqual([]);
  });

  it("keeps quoted paths and URLs separate without duplicate partial paths", () => {
    const path = String.raw`C:\Jane Doe\index.ts:12`;
    const url = "https://example.com/docs";
    const line = `"${path}" ${url} src/index.ts`;
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text: path, start: 1, end: 1 + path.length },
      { kind: "url", text: url, start: path.length + 3, end: path.length + 3 + url.length },
      { kind: "path", text: "src/index.ts", start: line.length - 12, end: line.length },
    ]);
  });

  it("classifies uppercase schemes as URLs at activation time too", () => {
    expect(isTerminalUrl("HTTPS://example.com/docs")).toBe(true);
    expect(isTerminalUrl("Http://example.com")).toBe(true);
    expect(isTerminalUrl("src/components/main.ts")).toBe(false);
    expect(isTerminalUrl("httpsdocs/readme.md")).toBe(false);
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

  it.each([
    "src/żółć.ts:12:7",
    "żółć/main.ts:12",
    String.raw`żółć\main.ts:12`,
    "src/cafe\u0301.ts:12",
    "src/𐐀.ts:12",
  ])("keeps the complete Unicode relative path %s", (text) => {
    expect(extractTerminalLinks(`see ${text} for details`)).toEqual([
      { kind: "path", text, start: 4, end: 4 + text.length },
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
    "GET /api?+debug 200",
    'Started GET "/posts?page=2" for ::1',
    "proxying api/trpc/post.list?batch=1 to the backend",
  ])("does not turn a logged request route into an editor link: %s", (line) => {
    expect(extractTerminalLinks(line)).toEqual([]);
  });

  it("keeps file and URL links before and after a logged request route", () => {
    const before = "src/server.ts:12";
    const after = "/app/bin/server:3:7";
    const url = "https://example.com/api/users?id=42";
    const line = `${before} GET /api/users?id=42 200 ${after} ${url}`;
    const afterStart = line.indexOf(after);
    const urlStart = line.indexOf(url);

    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text: before, start: 0, end: before.length },
      { kind: "path", text: after, start: afterStart, end: afterStart + after.length },
      { kind: "url", text: url, start: urlStart, end: urlStart + url.length },
    ]);
  });

  it("keeps a question mark inside a filesystem path", () => {
    const path = "/tmp/report?draft";
    expect(extractTerminalLinks(`wrote ${path}`)).toEqual([
      { kind: "path", text: path, start: 6, end: 6 + path.length },
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
  it("resolves a quoted terminal link against a Windows environment", () => {
    const [link] = extractTerminalLinks(String.raw`error at "src\my folder\index.ts":12:7`);
    expect(resolvePathLinkTarget(link?.text ?? "", String.raw`C:\Users\Jane Doe\project`)).toBe(
      String.raw`C:\Users\Jane Doe\project\src\my folder\index.ts:12:7`,
    );
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  // regression: #13408 terminal links kept a trailing colon
  it("keeps the line and column of a compiler diagnostic", () => {
    const [link] = extractTerminalLinks("/Users/julius/project/main.c:10:5: error: expected ';'");
    expect(resolvePathLinkTarget(link?.text ?? "", "/Users/julius/project")).toBe(
      "/Users/julius/project/main.c:10:5",
    );
  });
});
