import { describe, expect, it } from "vite-plus/test";
import { type WorkLogEntry } from "../../session-logic";
import {
  deriveWorkActivityDisplayEntries,
  summarizeWorkActivityEntries,
} from "./workActivitySummary";

function workEntry(overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return {
    createdAt: "2026-01-01T00:00:00Z",
    label: "Ran command",
    tone: "tool",
    ...overrides,
  };
}

describe("summarizeWorkActivityEntries", () => {
  it("groups search commands into an explored searches summary", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "search-1",
          command: 'rg -n "DocumentEditor|reviewThreads" apps/web/src',
          itemType: "command_execution",
          requestKind: "command",
        }),
        workEntry({
          id: "search-2",
          command: 'grep -R "commentToolbar" apps/web/src',
          itemType: "command_execution",
          requestKind: "command",
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "search",
        label: "Explored 2 searches",
        items: [
          { label: "Searched for DocumentEditor|reviewThreads" },
          { label: "Searched for commentToolbar" },
        ],
      },
    ]);
  });

  it("groups file read commands into an explored files summary", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "read-1",
          command: "sed -n '1,220p' /repo/apps/web/src/review-types.ts",
          itemType: "command_execution",
          requestKind: "command",
        }),
        workEntry({
          id: "read-2",
          command: "cat /repo/apps/web/src/editor-toolbar.tsx",
          itemType: "command_execution",
          requestKind: "command",
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "file",
        label: "Explored 2 files",
        items: [
          { label: "Read apps/web/src/review-types.ts" },
          { label: "Read apps/web/src/editor-toolbar.tsx" },
        ],
      },
    ]);
  });

  it("classifies shell-wrapped file exploration commands", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "pwd-1",
          command: "/bin/zsh -lc pwd",
          itemType: "command_execution",
          requestKind: "command",
        }),
        workEntry({
          id: "ls-1",
          command: "/bin/zsh -lc 'ls -la'",
          itemType: "command_execution",
          requestKind: "command",
        }),
        workEntry({
          id: "files-1",
          command: "/bin/zsh -lc \"rg --files -g 'AGENTS.md' -g 'package.json'\"",
          itemType: "command_execution",
          requestKind: "command",
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "file",
        label: "Explored 3 files",
        items: [
          { label: "Checked current directory" },
          { label: "Listed current directory" },
          { label: "Listed files" },
        ],
      },
    ]);
  });

  it("uses the file path before piped line-range commands", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "nl-1",
          command: "/bin/zsh -lc \"nl -ba apps/web/src/mockups-workspace.tsx | sed -n '1,80p'\"",
          itemType: "command_execution",
          requestKind: "command",
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "file",
        label: "Explored 1 file",
        items: [{ label: "Read apps/web/src/mockups-workspace.tsx" }],
      },
    ]);
  });

  it("keeps generic tool lifecycle updates visible for debugging without calling them commands", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "tool-updated-1",
          label: "Tool updated",
          requestKind: "command",
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "tool",
        label: "Used 1 tool",
        items: [{ label: "Updated tool" }],
      },
    ]);
  });

  it("expands multi-file edits into one item per changed file", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "edit-1",
          label: "Apply patch",
          itemType: "file_change",
          requestKind: "file-change",
          changedFiles: ["/repo/src/a.ts", "/repo/src/b.ts"],
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "edit",
        label: "Edited 2 files",
        items: [{ label: "Edited src/a.ts" }, { label: "Edited src/b.ts" }],
      },
    ]);
  });

  it("keeps assistant messages as boundaries between work summaries", () => {
    const displayEntries = deriveWorkActivityDisplayEntries(
      [
        {
          kind: "work",
          id: "search-entry",
          createdAt: "2026-01-01T00:00:00Z",
          workEntry: workEntry({
            id: "search-1",
            command: "rg toolbar apps/web",
            itemType: "command_execution",
            requestKind: "command",
          }),
        },
        {
          kind: "assistant-message",
          id: "assistant-entry",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Next I am reading files.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          kind: "work",
          id: "read-entry",
          createdAt: "2026-01-01T00:00:02Z",
          workEntry: workEntry({
            id: "read-1",
            command: "cat /repo/src/index.ts",
            itemType: "command_execution",
            requestKind: "command",
          }),
        },
      ],
      "/repo",
    );

    expect(displayEntries.map((entry) => entry.kind)).toEqual([
      "work-summary",
      "assistant-message",
      "work-summary",
    ]);
    expect(displayEntries[0]).toMatchObject({
      kind: "work-summary",
      summary: { label: "Explored 1 search" },
    });
    expect(displayEntries[2]).toMatchObject({
      kind: "work-summary",
      summary: { label: "Explored 1 file" },
    });
  });
});
