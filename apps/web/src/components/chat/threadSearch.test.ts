import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { TimelineRow } from "./MessagesTimeline.logic";
import {
  buildThreadSearchIndex,
  findThreadSearchLookupState,
  findThreadSearchResults,
  findThreadSearchResultsFromIndex,
} from "./threadSearch";

const rows: TimelineRow[] = [
  {
    kind: "message",
    id: "message-row",
    createdAt: "2026-03-28T12:00:00.000Z",
    durationStart: "2026-03-28T12:00:00.000Z",
    showCompletionDivider: false,
    message: {
      id: MessageId.makeUnsafe("message-1"),
      role: "assistant",
      text: "Needle in the response. Another needle is here.",
      createdAt: "2026-03-28T12:00:00.000Z",
      streaming: false,
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "needle-diagram.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
    },
  },
  {
    kind: "message",
    id: "assistant-markdown-row",
    createdAt: "2026-03-28T12:00:02.000Z",
    durationStart: "2026-03-28T12:00:02.000Z",
    showCompletionDivider: false,
    message: {
      id: MessageId.makeUnsafe("message-1a"),
      role: "assistant",
      text: [
        "See [thread search docs](https://example.com/thread-search) for **alpha marker** details.",
        "",
        "```ts",
        "const planSeed = 'seeded';",
        "```",
      ].join("\n"),
      createdAt: "2026-03-28T12:00:02.000Z",
      streaming: false,
      attachments: [],
    },
  },
  {
    kind: "message",
    id: "user-message-row",
    createdAt: "2026-03-28T12:00:05.000Z",
    durationStart: "2026-03-28T12:00:05.000Z",
    showCompletionDivider: false,
    message: {
      id: MessageId.makeUnsafe("message-1b"),
      role: "user",
      text: [
        "Visible composer text @terminal-1:1-5",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 1-5:",
        "  1 | hidden needle payload",
        "</terminal_context>",
      ].join("\n"),
      createdAt: "2026-03-28T12:00:05.000Z",
      streaming: false,
      attachments: [
        {
          type: "image",
          id: "attachment-hidden",
          name: "hidden-preview-name.png",
          mimeType: "image/png",
          sizeBytes: 512,
          previewUrl: "https://example.com/preview.png",
        },
        {
          type: "image",
          id: "attachment-visible",
          name: "visible-upload-name.png",
          mimeType: "image/png",
          sizeBytes: 256,
        },
      ],
    },
  },
  {
    kind: "work",
    id: "work-row",
    createdAt: "2026-03-28T12:00:10.000Z",
    groupedEntries: [
      {
        id: "work-1",
        createdAt: "2026-03-28T12:00:10.000Z",
        label: "Updated README completed",
        toolTitle: "Edit README completed",
        detail: "Added the migration note",
        command: "bun run lint",
        changedFiles: ["README.md"],
        tone: "info",
      },
    ],
  },
  {
    kind: "work",
    id: "work-row-visible-files",
    createdAt: "2026-03-28T12:00:15.000Z",
    groupedEntries: [
      {
        id: "work-2",
        createdAt: "2026-03-28T12:00:15.000Z",
        label: "Apply patch completed",
        command: "git status",
        changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        tone: "info",
      },
    ],
  },
  {
    kind: "proposed-plan",
    id: "plan-row",
    createdAt: "2026-03-28T12:00:20.000Z",
    proposedPlan: {
      id: "plan-1" as never,
      turnId: null,
      planMarkdown: [
        "# Seeded Thread Search Plan",
        "",
        "## Summary",
        "",
        "1. Add **thread search**",
        "2. Jump to the matching row",
        "3. Review [plan docs](https://example.com/plan-docs)",
      ].join("\n"),
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-03-28T12:00:20.000Z",
      updatedAt: "2026-03-28T12:00:20.000Z",
    },
  },
  {
    kind: "message",
    id: "assistant-empty-row",
    createdAt: "2026-03-28T12:00:25.000Z",
    durationStart: "2026-03-28T12:00:25.000Z",
    showCompletionDivider: false,
    message: {
      id: MessageId.makeUnsafe("message-empty"),
      role: "assistant",
      text: "",
      createdAt: "2026-03-28T12:00:25.000Z",
      streaming: false,
      attachments: [],
    },
  },
  {
    kind: "working",
    id: "working-row",
    createdAt: "2026-03-28T12:00:30.000Z",
  },
];

describe("findThreadSearchResults", () => {
  it("builds a normalized reusable search index once per row set", () => {
    expect(buildThreadSearchIndex(rows)).toEqual([
      {
        rowId: "message-row",
        rowIndex: 0,
        normalizedTexts: ["needle in the response. another needle is here."],
      },
      {
        rowId: "assistant-markdown-row",
        rowIndex: 1,
        normalizedTexts: [
          "see thread search docs for alpha marker details.\n\nconst planseed = 'seeded';",
        ],
      },
      {
        rowId: "user-message-row",
        rowIndex: 2,
        normalizedTexts: [
          "visible composer text @terminal-1:1-5",
          "terminal 1 lines 1-5",
          "visible-upload-name.png",
        ],
      },
      {
        rowId: "work-row",
        rowIndex: 3,
        normalizedTexts: ["edit readme", "bun run lint", "readme.md"],
      },
      {
        rowId: "work-row-visible-files",
        rowIndex: 4,
        normalizedTexts: [
          "apply patch",
          "git status",
          "src/a.ts",
          "src/b.ts",
          "src/c.ts",
          "src/d.ts",
        ],
      },
      {
        rowId: "plan-row",
        rowIndex: 5,
        normalizedTexts: [
          "seeded thread search plan",
          "add thread search\njump to the matching row\nreview plan docs",
        ],
      },
      {
        rowId: "assistant-empty-row",
        rowIndex: 6,
        normalizedTexts: ["(empty response)"],
      },
      {
        rowId: "working-row",
        rowIndex: 7,
        normalizedTexts: [],
      },
    ]);
  });

  it("finds message matches case-insensitively and counts repeated hits", () => {
    expect(findThreadSearchResults(rows, "needle")).toEqual([
      {
        rowId: "message-row",
        rowIndex: 0,
        matchCount: 2,
      },
    ]);
  });

  it("matches work log details and changed files", () => {
    expect(findThreadSearchResults(rows, "readme")).toEqual([
      {
        rowId: "work-row",
        rowIndex: 3,
        matchCount: 2,
      },
    ]);
  });

  it("matches tool titles shown in work log headings", () => {
    expect(findThreadSearchResults(rows, "edit readme")).toEqual([
      {
        rowId: "work-row",
        rowIndex: 3,
        matchCount: 1,
      },
    ]);
  });

  it("matches displayed proposed-plan body content and ignores the working indicator", () => {
    expect(findThreadSearchResults(rows, "jump to the matching row")).toEqual([
      {
        rowId: "plan-row",
        rowIndex: 5,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "working")).toEqual([]);
  });

  it("ignores hidden terminal-context payloads and hidden preview attachment names", () => {
    expect(findThreadSearchResults(rows, "hidden needle payload")).toEqual([]);
    expect(findThreadSearchResults(rows, "hidden-preview-name")).toEqual([]);
    expect(findThreadSearchResults(rows, "visible composer text")).toEqual([
      {
        rowId: "user-message-row",
        rowIndex: 2,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "terminal 1 lines 1-5")).toEqual([
      {
        rowId: "user-message-row",
        rowIndex: 2,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "visible-upload-name")).toEqual([
      {
        rowId: "user-message-row",
        rowIndex: 2,
        matchCount: 1,
      },
    ]);
  });

  it("matches only the rendered work heading and visible changed-file paths", () => {
    expect(findThreadSearchResults(rows, "apply patch")).toEqual([
      {
        rowId: "work-row-visible-files",
        rowIndex: 4,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "completed")).toEqual([]);
    expect(findThreadSearchResults(rows, "src/d.ts")).toEqual([
      {
        rowId: "work-row-visible-files",
        rowIndex: 4,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "src/e.ts")).toEqual([]);
  });

  it("indexes assistant markdown by rendered text instead of raw markdown syntax", () => {
    expect(findThreadSearchResults(rows, "thread search docs")).toEqual([
      {
        rowId: "assistant-markdown-row",
        rowIndex: 1,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "alpha marker")).toEqual([
      {
        rowId: "assistant-markdown-row",
        rowIndex: 1,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "https://example.com/thread-search")).toEqual([]);
  });

  it("indexes proposed plans by displayed title and body instead of raw markdown", () => {
    expect(findThreadSearchResults(rows, "seeded thread search plan")).toEqual([
      {
        rowId: "plan-row",
        rowIndex: 5,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "plan docs")).toEqual([
      {
        rowId: "plan-row",
        rowIndex: 5,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "summary")).toEqual([]);
    expect(findThreadSearchResults(rows, "https://example.com/plan-docs")).toEqual([]);
  });

  it("indexes the rendered empty assistant placeholder text", () => {
    expect(findThreadSearchResults(rows, "(empty response)")).toEqual([
      {
        rowId: "assistant-empty-row",
        rowIndex: 6,
        matchCount: 1,
      },
    ]);
  });

  it("returns no results for empty queries", () => {
    expect(findThreadSearchResults(rows, "   ")).toEqual([]);
  });

  it("returns matching rows in timeline order when several rows match", () => {
    expect(findThreadSearchResults(rows, "row")).toEqual([
      {
        rowId: "plan-row",
        rowIndex: 5,
        matchCount: 1,
      },
    ]);
  });

  it("reuses the prebuilt index for result lookup", () => {
    const index = buildThreadSearchIndex(rows);
    expect(findThreadSearchResultsFromIndex(index, "needle")).toEqual(
      findThreadSearchResults(rows, "needle"),
    );
  });

  it("narrows from the previous matching rows when the query extends", () => {
    const index = buildThreadSearchIndex(rows);
    const previousState = findThreadSearchLookupState(index, "need");
    const nextState = findThreadSearchLookupState(index, "needle", previousState);

    expect(previousState.matchingEntries.map((entry) => entry.rowId)).toEqual(["message-row"]);
    expect(nextState.matchingEntries.map((entry) => entry.rowId)).toEqual(["message-row"]);
    expect(nextState.results).toEqual([
      {
        rowId: "message-row",
        rowIndex: 0,
        matchCount: 2,
      },
    ]);
  });

  it("rescans the full index when the query broadens", () => {
    const index = buildThreadSearchIndex(rows);
    const previousState = findThreadSearchLookupState(index, "thread search");
    const nextState = findThreadSearchLookupState(index, "e", previousState);

    expect(previousState.matchingEntries.map((entry) => entry.rowId)).toEqual([
      "assistant-markdown-row",
      "plan-row",
    ]);
    expect(nextState.results).toEqual(findThreadSearchResultsFromIndex(index, "e"));
  });
});
