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
    kind: "work",
    id: "work-row",
    createdAt: "2026-03-28T12:00:10.000Z",
    groupedEntries: [
      {
        id: "work-1",
        createdAt: "2026-03-28T12:00:10.000Z",
        label: "Updated README",
        detail: "Added the migration note",
        command: "bun run lint",
        changedFiles: ["README.md"],
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
      planMarkdown: "1. Add thread search\n2. Jump to the matching row",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-03-28T12:00:20.000Z",
      updatedAt: "2026-03-28T12:00:20.000Z",
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
        normalizedTexts: ["needle in the response. another needle is here.", "needle-diagram.png"],
      },
      {
        rowId: "work-row",
        rowIndex: 1,
        normalizedTexts: [
          "updated readme",
          "added the migration note",
          "bun run lint",
          "readme.md",
        ],
      },
      {
        rowId: "plan-row",
        rowIndex: 2,
        normalizedTexts: ["1. add thread search\n2. jump to the matching row"],
      },
      {
        rowId: "working-row",
        rowIndex: 3,
        normalizedTexts: [],
      },
    ]);
  });

  it("finds message matches case-insensitively and counts repeated hits", () => {
    expect(findThreadSearchResults(rows, "needle")).toEqual([
      {
        rowId: "message-row",
        rowIndex: 0,
        matchCount: 3,
      },
    ]);
  });

  it("matches work log details and changed files", () => {
    expect(findThreadSearchResults(rows, "readme")).toEqual([
      {
        rowId: "work-row",
        rowIndex: 1,
        matchCount: 2,
      },
    ]);
  });

  it("matches proposed plans and ignores the working indicator", () => {
    expect(findThreadSearchResults(rows, "thread search")).toEqual([
      {
        rowId: "plan-row",
        rowIndex: 2,
        matchCount: 1,
      },
    ]);
    expect(findThreadSearchResults(rows, "working")).toEqual([]);
  });

  it("returns no results for empty queries", () => {
    expect(findThreadSearchResults(rows, "   ")).toEqual([]);
  });

  it("returns matching rows in timeline order when several rows match", () => {
    expect(findThreadSearchResults(rows, "row")).toEqual([
      {
        rowId: "plan-row",
        rowIndex: 2,
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
        matchCount: 3,
      },
    ]);
  });

  it("rescans the full index when the query broadens", () => {
    const index = buildThreadSearchIndex(rows);
    const previousState = findThreadSearchLookupState(index, "thread search");
    const nextState = findThreadSearchLookupState(index, "e", previousState);

    expect(previousState.matchingEntries.map((entry) => entry.rowId)).toEqual(["plan-row"]);
    expect(nextState.results).toEqual(findThreadSearchResultsFromIndex(index, "e"));
  });
});
