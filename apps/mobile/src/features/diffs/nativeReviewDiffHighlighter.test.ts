import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { highlightCode } from "../../lib/highlights";

import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import { highlightNativeReviewDiffVisibleRows } from "./nativeReviewDiffHighlighter";
import { buildNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";

const tokenization = vi.hoisted(() => ({
  calls: [] as string[],
  afterCall: undefined as (() => void) | undefined,
}));

vi.mock("expo", async () => {
  const { createWasmHighlightsModule } = await import("../../lib/highlights.testing");
  const module = createWasmHighlightsModule();
  return {
    requireOptionalNativeModule: () => ({
      tokenize(code: string, language: number) {
        tokenization.calls.push(code);
        const records = module.tokenize(code, language);
        tokenization.afterCall?.();
        return records;
      },
    }),
  };
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

function authoritativeTokens(source: ReadonlyArray<string>) {
  return highlightCode(source.join("\n"), "typescript", "dark");
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
    const oldTokens = await authoritativeTokens(OLD_SOURCE);
    const newTokens = await authoritativeTokens(newSource);
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
        (row.newLineNumber ?? row.oldLineNumber)! <= 4 ? "#5ecc71" : "#737373",
      );
    }
    expect(lineRows.map((row) => row.content)).toEqual(originalContents);
    expect(result.retryableRowIds).toEqual([]);
  });

  it("matches full OLD/NEW source across replacement runs and shared multiline context", async () => {
    const rows = completeDiffRows();
    const oldTokens = await authoritativeTokens(OLD_SOURCE);
    const newTokens = await authoritativeTokens(NEW_SOURCE);
    const result = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
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
    const oldTokens = await authoritativeTokens(oldSource);
    const newTokens = await authoritativeTokens(newSource);
    const result = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
    });
    expect(oldTokens[1]).not.toEqual(newTokens[1]);
    expect(result.tokensByRowId.shared).toEqual(newTokens[1]);
    expect(result.tokensByRowId["old-tail"]).toEqual(oldTokens[2]);
    expect(result.tokensByRowId["new-tail"]).toEqual(newTokens[2]);
  });

  it("leaves mismatched and unavailable source revisions plain", async () => {
    const rows = [sourceRow("add", 3)];
    for (const source of [null, { oldContents: "", newContents: "different revision" }]) {
      const result = await highlightNativeReviewDiffVisibleRows({
        rows,
        files: [{ ...TYPESCRIPT_FILE, loadContents: async () => source }],
        scheme: "dark",
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

it("reuses full native records across viewport and theme changes and evicts old entries", async () => {
  const sources = Array.from({ length: 9 }, (_, i) => ({
    oldContents: "",
    newContents: `/* ${i}\ninside\n*/\nconst tail = 2;`,
  }));
  const rows = [
    makeLine({
      id: "body",
      content: "inside",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    }),
    makeLine({
      id: "tail",
      content: "const tail = 2;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 4,
    }),
  ];
  const input = {
    rows,
    scheme: "dark" as const,
    firstRowIndex: 0,
    lastRowIndex: 0,
    overscanRows: 0,
  };
  const files = [{ ...TYPESCRIPT_FILE, loadContents: async () => sources[0]! }];
  const initial = await highlightNativeReviewDiffVisibleRows({ ...input, files });
  const moved = await highlightNativeReviewDiffVisibleRows({
    ...input,
    files,
    firstRowIndex: 1,
    lastRowIndex: 1,
  });
  await highlightNativeReviewDiffVisibleRows({ ...input, files, scheme: "light" });
  expect(tokenization.calls).toEqual([sources[0]!.newContents]);
  expect(initial.tokensByRowId.body).toEqual(
    highlightCode(sources[0]!.newContents, "typescript", "dark")[1],
  );
  expect(moved.tokensByRowId.tail).toEqual(
    highlightCode(sources[0]!.newContents, "typescript", "dark")[3],
  );
  tokenization.calls = [];
  for (const source of sources.slice(1)) {
    await highlightNativeReviewDiffVisibleRows({
      ...input,
      files: [{ ...TYPESCRIPT_FILE, loadContents: async () => source }],
    });
  }
  await highlightNativeReviewDiffVisibleRows({ ...input, files });
  expect(tokenization.calls).toHaveLength(9);
  expect(tokenization.calls.at(-1)).toBe(sources[0]!.newContents);
});

it("reuses segment records across themes and replaces records when the language changes", async () => {
  const rows = [
    makeLine({
      id: "line",
      content: "const value = 1;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    }),
  ];
  const input = {
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark" as const,
    firstRowIndex: 0,
    lastRowIndex: 0,
    overscanRows: 0,
  };
  const first = await highlightNativeReviewDiffVisibleRows(input);
  await highlightNativeReviewDiffVisibleRows({ ...input, scheme: "light" });
  expect(tokenization.calls).toEqual([rows[0]!.content]);
  await highlightNativeReviewDiffVisibleRows({
    ...input,
    files: [{ ...TYPESCRIPT_FILE, language: "c" }],
  });
  const restored = await highlightNativeReviewDiffVisibleRows(input);
  expect(tokenization.calls).toHaveLength(3);
  expect(restored.tokensByRowId).toEqual(first.tokensByRowId);
});

it("uses full grammar after an oversized line and expands only selected rows in a 100k-line C source", async () => {
  const contents = [
    " ".repeat(1_001) + "/*",
    ...Array.from({ length: 99_997 }, (_, i) => `comment ${i}: int value = 1;`),
    "*/",
    "int done = 2;",
  ].join("\n");
  expect(contents.length).toBeGreaterThan(500_000);
  const source = { oldContents: "", newContents: contents };
  const rows = [
    makeLine({
      id: "body",
      content: "comment 99996: int value = 1;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 99_998,
    }),
    makeLine({
      id: "end",
      content: "int done = 2;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 100_000,
    }),
  ];
  const input = {
    rows,
    files: [{ ...TYPESCRIPT_FILE, language: "c", loadContents: async () => source }],
    scheme: "dark" as const,
    firstRowIndex: 0,
    lastRowIndex: 0,
    overscanRows: 0,
  };
  const result = await highlightNativeReviewDiffVisibleRows(input);
  expect(Object.keys(result.tokensByRowId)).toEqual(["body"]);
  expect(result.tokensByRowId.body).toEqual([
    { content: rows[0]!.content, color: "#737373", fontStyle: 0 },
  ]);
  const moved = await highlightNativeReviewDiffVisibleRows({
    ...input,
    firstRowIndex: 1,
    lastRowIndex: 1,
  });
  expect(moved.tokensByRowId.end?.some((token) => token.color !== "#737373")).toBe(true);
  expect(tokenization.calls).toEqual([contents]);
});

it("publishes no cancelled file chunk and never tokenizes its next side", async () => {
  const controller = new AbortController();
  tokenization.afterCall = () => controller.abort();
  const chunks = vi.fn();
  const result = await highlightNativeReviewDiffVisibleRows({
    rows: [sourceRow("delete", 3), sourceRow("add", 3)],
    files: [
      {
        ...TYPESCRIPT_FILE,
        loadContents: async () => ({
          oldContents: OLD_SOURCE.join("\n"),
          newContents: NEW_SOURCE.join("\n"),
        }),
      },
    ],
    scheme: "dark",
    firstRowIndex: 0,
    lastRowIndex: 1,
    overscanRows: 0,
    signal: controller.signal,
    onChunk: chunks,
  });
  expect(tokenization.calls).toHaveLength(1);
  expect(chunks).not.toHaveBeenCalled();
  expect(result.tokensByRowId).toEqual({});
  expect(result.rowCount).toBe(0);
});

it("does not tokenize or publish a source that arrives after cancellation", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ oldContents: string; newContents: string }>();
  const chunks = vi.fn();
  const work = highlightNativeReviewDiffVisibleRows({
    rows: [sourceRow("add", 3)],
    files: [
      {
        ...TYPESCRIPT_FILE,
        loadContents: () => {
          started.resolve();
          return response.promise;
        },
      },
    ],
    scheme: "dark",
    firstRowIndex: 0,
    lastRowIndex: 0,
    signal: controller.signal,
    onChunk: chunks,
  });
  await started.promise;
  controller.abort();
  response.resolve({ oldContents: "", newContents: NEW_SOURCE.join("\n") });
  expect((await work).rowCount).toBe(0);
  expect(tokenization.calls).toEqual([]);
  expect(chunks).not.toHaveBeenCalled();
});
