import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import {
  getNativeReviewDiffHighlighter,
  highlightNativeReviewDiffVisibleRows,
} from "./nativeReviewDiffHighlighter";
import { buildNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";

const tokenization = vi.hoisted(() => ({
  calls: [] as string[],
  afterCall: undefined as (() => void) | undefined,
}));

vi.mock("@shikijs/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shikijs/core")>();
  return {
    ...original,
    createHighlighterCore: async (...args: Parameters<typeof original.createHighlighterCore>) => {
      const highlighter = await original.createHighlighterCore(...args);
      return {
        ...highlighter,
        codeToTokensBase: (...input: Parameters<typeof highlighter.codeToTokensBase>) => {
          tokenization.calls.push(input[0]);
          const result = highlighter.codeToTokensBase(...input);
          tokenization.afterCall?.();
          return result;
        },
      };
    },
  };
});

vi.mock("react-native-shiki-engine", async () => {
  const { createJavaScriptRegexEngine } = await import("@shikijs/engine-javascript");
  return { isNativeEngineAvailable: () => true, createNativeEngine: createJavaScriptRegexEngine };
});

afterEach(() => {
  tokenization.calls = [];
  tokenization.afterCall = undefined;
});

const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 0,
  deletions: 0,
};

function makeLine(
  input: Pick<NativeReviewDiffRow, "id" | "content" | "change" | "oldLineNumber" | "newLineNumber">,
): NativeReviewDiffRow {
  return {
    kind: "line",
    fileId: TYPESCRIPT_FILE.id,
    ...input,
  };
}

function makeHunk(id: string): NativeReviewDiffRow {
  return {
    kind: "hunk",
    id,
    fileId: TYPESCRIPT_FILE.id,
    text: "@@",
  };
}

function highlight(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  alreadyHighlightedRowIds?: ReadonlySet<string>,
) {
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
    maxRows: 100,
    alreadyHighlightedRowIds,
  });
}

describe("highlightNativeReviewDiffVisibleRows", () => {
  it("keeps overscan within the visible files, including a file header at the viewport edge", async () => {
    const loadedFiles: string[] = [];
    const files = Array.from({ length: 14 }, (_, index) => {
      const id = `file-${index}`;
      const source = Array.from({ length: 3 }, (_, line) => `const value${line} = ${line};`);
      return {
        ...TYPESCRIPT_FILE,
        id,
        loadContents: async () => {
          loadedFiles.push(id);
          return { oldContents: "", newContents: source.join("\n") };
        },
        rows: [
          { kind: "file", id: `${id}-header`, fileId: id },
          ...source.map((content, line) => ({
            ...makeLine({
              id: `${id}-line-${line + 1}`,
              content,
              change: "add",
              oldLineNumber: null,
              newLineNumber: line + 1,
            }),
            fileId: id,
          })),
        ] satisfies NativeReviewDiffRow[],
      };
    });
    const input = {
      rows: files.flatMap((file) => file.rows),
      files,
      scheme: "dark" as const,
      engine: "javascript" as const,
      firstRowIndex: 30,
      lastRowIndex: 32,
    };
    const viewport = await highlightNativeReviewDiffVisibleRows({ ...input, overscanRows: 0 });
    const visibleIds = ["file-7-line-2", "file-7-line-3"];
    expect(Object.keys(viewport.tokensByRowId)).toEqual(visibleIds);
    const overscan = await highlightNativeReviewDiffVisibleRows({
      ...input,
      overscanRows: 160,
      alreadyHighlightedRowIds: new Set(visibleIds),
    });
    expect(Object.keys(overscan.tokensByRowId).sort()).toEqual([
      "file-7-line-1",
      "file-8-line-1",
      "file-8-line-2",
      "file-8-line-3",
    ]);
    for (const tokens of Object.values({ ...viewport.tokensByRowId, ...overscan.tokensByRowId })) {
      expect(tokens.some((token) => token.color !== null)).toBe(true);
    }
    expect([...new Set(loadedFiles)].sort()).toEqual(["file-7", "file-8"]);
  });

  it("delivers the dominant viewport file before fetching a smaller blocked neighbor", async () => {
    const neighborStarted = Promise.withResolvers<void>();
    const neighborResponse = Promise.withResolvers<{ oldContents: string; newContents: string }>();
    const source = Array.from({ length: 27 }, (_, index) => `const value${index} = true;`).join(
      "\n",
    );
    const chunks = vi.fn();
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...makeLine({
          id: `neighbor-${index}`,
          content: `const value${index} = true;`,
          change: "add",
          oldLineNumber: null,
          newLineNumber: index + 1,
        }),
        fileId: "neighbor",
      })),
      ...Array.from({ length: 27 }, (_, index) =>
        makeLine({
          id: `selected-${index}`,
          content: `const value${index} = true;`,
          change: "delete",
          oldLineNumber: index + 1,
          newLineNumber: null,
        }),
      ),
    ];
    const highlighting = highlightNativeReviewDiffVisibleRows({
      rows,
      files: [
        {
          ...TYPESCRIPT_FILE,
          id: "neighbor",
          loadContents: () => {
            neighborStarted.resolve();
            return neighborResponse.promise;
          },
        },
        {
          ...TYPESCRIPT_FILE,
          loadContents: async () => ({ oldContents: source, newContents: "" }),
        },
      ],
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
      onChunk: chunks,
    });
    try {
      await neighborStarted.promise;
      expect(chunks).toHaveBeenCalledTimes(1);
      expect(Object.keys(chunks.mock.calls[0]![0].tokensByRowId)).toEqual(
        Array.from({ length: 27 }, (_, index) => `selected-${index}`),
      );
      expect(
        chunks.mock.calls[0]![0].tokensByRowId["selected-0"].some(
          (token: { color: string | null }) => token.color !== null,
        ),
      ).toBe(true);
    } finally {
      neighborResponse.resolve({ oldContents: "", newContents: source });
      await highlighting;
    }
  });

  it("does not carry grammar state across hunk boundaries", async () => {
    const exportRow = makeLine({
      id: "export-row",
      content: "export async function run() {}",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 100,
    });
    const rows = [
      makeHunk("hunk-1"),
      makeLine({
        id: "import-open",
        content: "import {",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      }),
      makeLine({
        id: "import-entry",
        content: "  Model,",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
      }),
      makeHunk("hunk-2"),
      exportRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([makeHunk("standalone-hunk"), exportRow]),
    ]);

    expect(highlighted.tokensByRowId[exportRow.id]).toEqual(standalone.tokensByRowId[exportRow.id]);
  });

  it("keeps grammar state across inline comment rows", async () => {
    const openingRow = makeLine({
      id: "template-open",
      content: "const message = `open",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const closingRow = makeLine({
      id: "template-close",
      content: "closed`;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    });
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const commentRow: NativeReviewDiffRow = {
      kind: "comment",
      id: "comment-1",
      fileId: TYPESCRIPT_FILE.id,
      commentText: "Review note",
    };

    const [withComment, contiguous] = await Promise.all([
      highlight([openingRow, commentRow, closingRow, trailingRow]),
      highlight([openingRow, closingRow, trailingRow]),
    ]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
  });

  it("does not join unhighlighted rows across cached gaps", async () => {
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const rows = [
      makeLine({
        id: "template-open",
        content: "const message = `open",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "template-close",
        content: "closed`;",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
      }),
      trailingRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows, new Set(["template-close"])),
      highlight([trailingRow]),
    ]);

    expect(highlighted.tokensByRowId[trailingRow.id]).toEqual(
      standalone.tokensByRowId[trailingRow.id],
    );
  });
});

describe.each(["native", "javascript"] as const)("%s highlighting budgets", (engine) => {
  const highlightRows = (rows: ReadonlyArray<NativeReviewDiffRow>, signal?: AbortSignal) =>
    highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
      signal,
    });

  const line = (id: number, content: string) =>
    makeLine({
      id: `line-${id}`,
      content,
      change: "add",
      oldLineNumber: null,
      newLineNumber: id,
    });

  it("keeps only the long line plain and resumes highlighting after it", async () => {
    const longLine = `${"x".repeat(1_001)} /*`;
    const rows = [
      line(1, "export const before = 1;"),
      line(2, longLine),
      { kind: "comment", id: "note", commentText: "Check this", fileId: TYPESCRIPT_FILE.id },
      line(3, "export const inside = 'x';"),
      makeHunk("next-hunk"),
      line(100, "export const after = 2;"),
    ] satisfies ReadonlyArray<NativeReviewDiffRow>;
    const result = await highlightRows(rows);

    expect(result.engine).toBe(engine);
    expect(Object.keys(result.tokensByRowId)).toEqual(["line-1", "line-2", "line-3", "line-100"]);
    expect(result.tokensByRowId["line-2"]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
    for (const id of ["line-1", "line-3", "line-100"]) {
      expect(result.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
    }
    expect(tokenization.calls.some((code) => code.includes(longLine))).toBe(false);
  });

  it("highlights the rows after a long line the same regardless of the first window", async () => {
    const rows = [
      line(1, "export const before = 1;"),
      line(2, `const data = "${"x".repeat(1_050)}";`),
      line(3, "export const inside = 'x';"),
      line(4, "export const after = 2;"),
    ];
    const spanning = await highlightRows(rows);
    const afterLongLine = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 2,
      lastRowIndex: 3,
      overscanRows: 0,
    });

    for (const id of ["line-3", "line-4"]) {
      expect(spanning.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
      expect(afterLongLine.tokensByRowId[id]).toEqual(spanning.tokensByRowId[id]);
    }
  });

  it("preserves multiline grammar and row mapping across character-limited batches", async () => {
    const opening = line(1, "const message = `open");
    const body = Array.from({ length: 40 }, (_, index) => line(index + 2, "inside ".repeat(45)));
    const closing = line(42, "closed`; ");
    const trailing = line(43, "export const after = 2;");
    const result = await highlightRows([opening, ...body, closing, trailing]);
    const calls = [...tokenization.calls];
    const expected = await highlightRows([
      opening,
      { ...closing, newLineNumber: 2 },
      { ...trailing, newLineNumber: 3 },
    ]);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((code) => code.length <= 8_000)).toBe(true);
    expect(result.rowCount).toBe(43);
    for (const row of [opening, ...body, closing, trailing]) {
      expect(result.tokensByRowId[row.id]?.map((token) => token.content).join("")).toBe(
        row.content,
      );
    }
    expect(result.tokensByRowId[closing.id]).toEqual(expected.tokensByRowId[closing.id]);
    expect(result.tokensByRowId[trailing.id]).toEqual(expected.tokensByRowId[trailing.id]);
  });

  it("stops before later batches and publishes no partial result after cancellation", async () => {
    const controller = new AbortController();
    tokenization.afterCall = () => controller.abort();
    const rows = Array.from({ length: 30 }, (_, index) => line(index + 1, `// ${"x".repeat(400)}`));

    const result = await highlightRows(rows, controller.signal);

    expect(tokenization.calls).toHaveLength(1);
    expect(result.rowCount).toBe(0);
    expect(result.tokensByRowId).toEqual({});
  });
});

// These complete sources are independent of the diff row selection below.
const OLD_SOURCE = [
  "export function render(name: string) {",
  "  const heading = `Hello ${name}",
  "Welcome to the archive.",
  "Your saved reports follow.",
  "  `;",
  "  /* Historical formatting rules:",
  "   * Keep the title and summary together.",
  "   * Preserve links in the footer.",
  "   */",
  "  return heading.trim();",
  "}",
];
const NEW_SOURCE = [
  "export function render(name: string) {",
  "  const heading = `Greetings ${name}",
  "Welcome to the workspace.",
  "Your saved reports follow.",
  "  `;",
  "  /* Current formatting rules:",
  "   * Keep the title and summary together.",
  "   * Highlight links in the footer.",
  "   */",
  "  return heading.trim();",
  "}",
];

async function authoritativeTokens(source: ReadonlyArray<string>, engine: "native" | "javascript") {
  const highlighter = await getNativeReviewDiffHighlighter(engine);
  return highlighter.tokenize(source.join("\n"), { lang: "typescript", theme: "t3-pierre-dark" });
}

function sourceRow(change: "context" | "add" | "delete", lineNumber: number) {
  return makeLine({
    id: `${change}-${lineNumber}`,
    content: (change === "delete" ? OLD_SOURCE : NEW_SOURCE)[lineNumber - 1]!,
    change,
    oldLineNumber: change === "add" ? null : lineNumber,
    newLineNumber: change === "delete" ? null : lineNumber,
  });
}

function completeDiffRows() {
  return [
    sourceRow("context", 1),
    sourceRow("delete", 2),
    sourceRow("delete", 3),
    sourceRow("add", 2),
    sourceRow("add", 3),
    sourceRow("context", 4),
    sourceRow("context", 5),
    sourceRow("delete", 6),
    sourceRow("add", 6),
    sourceRow("context", 7),
    sourceRow("delete", 8),
    sourceRow("add", 8),
    sourceRow("context", 9),
    sourceRow("context", 10),
    sourceRow("context", 11),
  ];
}

describe("source context", () => {
  const engine = "javascript";
  it("highlights parsed CRLF patch rows using omitted full-source templates and comments", async () => {
    const newSource = [...OLD_SOURCE];
    newSource[2] = NEW_SOURCE[2]!;
    newSource[7] = NEW_SOURCE[7]!;
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -3,2 +3,2 @@",
        `-${OLD_SOURCE[2]}\r`,
        `+${newSource[2]}\r`,
        ` ${newSource[3]}\r`,
        "@@ -7,3 +7,3 @@",
        ` ${newSource[6]}\r`,
        `-${OLD_SOURCE[7]}\r`,
        `+${newSource[7]}\r`,
        ` ${newSource[8]}\r`,
        "",
      ].join("\n"),
      "crlf-context",
    );
    expect(parsed.kind).toBe("files");
    const { rows, files } = buildNativeReviewDiffData(parsed);
    const lineRows = rows.filter((row) => row.kind === "line");
    expect(lineRows).toHaveLength(7);
    const originalContents = lineRows.map((row) => row.content);
    expect(originalContents.every((content) => content?.endsWith("\r"))).toBe(true);
    const oldTokens = await authoritativeTokens(OLD_SOURCE, engine);
    const newTokens = await authoritativeTokens(newSource, engine);
    const result = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: files.map((file) => ({
        ...file,
        loadContents: async () => ({
          oldContents: `${OLD_SOURCE.join("\r\n")}\r\n`,
          newContents: `${newSource.join("\r\n")}\r\n`,
        }),
      })),
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
    });
    for (const row of lineRows) {
      const expected =
        row.change === "delete"
          ? oldTokens[row.oldLineNumber! - 1]
          : newTokens[row.newLineNumber! - 1];
      const tokens = result.tokensByRowId[row.id];
      expect(tokens, row.id).toEqual(expected);
      expect(
        tokens?.every((token) => token.color !== null),
        row.id,
      ).toBe(true);
      expect(tokens?.[0]?.color, row.id).toBe(
        (row.newLineNumber ?? row.oldLineNumber)! <= 4 ? "#5ECC71" : "#84848A",
      );
    }
    expect(lineRows.map((row) => row.content)).toEqual(originalContents);
    expect(result.retryableRowIds).toEqual([]);
  });

  it("matches full OLD/NEW source across replacement runs and shared multiline context", async () => {
    const rows = completeDiffRows();
    const oldTokens = await authoritativeTokens(OLD_SOURCE, engine);
    const newTokens = await authoritativeTokens(NEW_SOURCE, engine);
    const result = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
    });
    for (const row of rows) {
      const expected =
        row.change === "delete"
          ? oldTokens[row.oldLineNumber! - 1]
          : newTokens[row.newLineNumber! - 1];
      expect(result.tokensByRowId[row.id], row.id).toEqual(expected);
    }
  });

  it("uses NEW grammar for shared rows when OLD remains inside a comment", async () => {
    const oldSource = ["/* Retired renderer", "const value = 3;", "finish();"];
    const newSource = ["// Active renderer", "const value = 3;", "finish();"];
    const rows = [
      makeLine({
        id: "old-open",
        content: oldSource[0],
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
      }),
      makeLine({
        id: "new-open",
        content: newSource[0],
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "shared",
        content: newSource[1],
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
      }),
      makeLine({
        id: "old-tail",
        content: oldSource[2],
        change: "delete",
        oldLineNumber: 3,
        newLineNumber: null,
      }),
      makeLine({
        id: "new-tail",
        content: newSource[2],
        change: "add",
        oldLineNumber: null,
        newLineNumber: 3,
      }),
    ];
    const oldTokens = await authoritativeTokens(oldSource, engine);
    const newTokens = await authoritativeTokens(newSource, engine);
    const result = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
    });
    expect(oldTokens[1]).not.toEqual(newTokens[1]);
    expect(result.tokensByRowId.shared).toEqual(newTokens[1]);
    expect(result.tokensByRowId["old-tail"]).toEqual(oldTokens[2]);
    expect(result.tokensByRowId["new-tail"]).toEqual(newTokens[2]);
  });

  it("leaves mismatched source revisions and budget-limited files plain", async () => {
    const rows = [sourceRow("add", 3)];
    for (const source of [null, { oldContents: "", newContents: "different revision" }]) {
      const result = await highlightNativeReviewDiffVisibleRows({
        rows,
        files: [{ ...TYPESCRIPT_FILE, loadContents: async () => source }],
        scheme: "dark",
        engine,
        firstRowIndex: 0,
        lastRowIndex: 0,
        overscanRows: 0,
      });
      expect(result.tokensByRowId[rows[0]!.id]).toEqual([
        { content: NEW_SOURCE[2], color: null, fontStyle: null },
      ]);
    }
  });
});
