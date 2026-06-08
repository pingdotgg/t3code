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

  it("classifies provider built-in Read tools as file reads using the tool name", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "read-1",
          label: "Tool call",
          toolTitle: "Tool call",
          toolName: "Read",
          itemType: "dynamic_tool_call",
          detail: 'Read: {"file_path":"/repo/apps/server/src/orchestration/decider.ts"}',
        }),
        workEntry({
          id: "read-2",
          label: "Tool call",
          toolTitle: "Tool call",
          toolName: "Read",
          itemType: "dynamic_tool_call",
          detail: 'Read: {"file_path":"/repo/apps/server/src/cli/project.ts"}',
        }),
        workEntry({
          id: "read-3",
          label: "Tool call",
          toolTitle: "Tool call",
          toolName: "Read",
          itemType: "dynamic_tool_call",
          detail: 'Read: {"file_path":"/repo/apps/web/src/components/Sidebar.tsx"}',
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "file",
        label: "Explored 3 files",
        items: [
          { label: "Read apps/server/src/orchestration/decider.ts" },
          { label: "Read apps/server/src/cli/project.ts" },
          { label: "Read apps/web/src/components/Sidebar.tsx" },
        ],
      },
    ]);
  });

  it("does not double the verb when the read detail is a 'Read: <path>' prefix", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "read-1",
          label: "File read",
          toolTitle: "File read",
          toolName: "Read",
          itemType: "file_read",
          detail: "Read: /repo/apps/web/src/components/DiffPanelToolbar.tsx",
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "file",
        label: "Explored 1 file",
        items: [{ label: "Read apps/web/src/components/DiffPanelToolbar.tsx" }],
      },
    ]);
  });

  it("does not double the verb for edits when changed files use snake_case paths", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "edit-1",
          label: "File change",
          toolTitle: "File change",
          toolName: "Edit",
          itemType: "file_change",
          requestKind: "file-change",
          detail: 'Edit: {"replace_all":false,"file_path":"/repo/apps/web/src/a.ts"}',
          changedFiles: ["/repo/apps/web/src/a.ts"],
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([
      {
        category: "edit",
        label: "Edited 1 file",
        items: [{ label: "Edited apps/web/src/a.ts" }],
      },
    ]);
  });

  it("classifies provider built-in Grep tools as file exploration", () => {
    const summaries = summarizeWorkActivityEntries(
      [
        workEntry({
          id: "grep-1",
          label: "Tool call",
          toolName: "Grep",
          itemType: "dynamic_tool_call",
          detail: 'Grep: {"pattern":"foo","path":"src"}',
        }),
      ],
      "/repo",
    );

    expect(summaries).toMatchObject([{ category: "file" }]);
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

  it("combines adjacent work categories between assistant messages", () => {
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
          kind: "work",
          id: "read-entry-1",
          createdAt: "2026-01-01T00:00:01Z",
          workEntry: workEntry({
            id: "read-1",
            command: "cat /repo/src/index.ts",
            itemType: "command_execution",
            requestKind: "command",
          }),
        },
        {
          kind: "work",
          id: "read-entry-2",
          createdAt: "2026-01-01T00:00:02Z",
          workEntry: workEntry({
            id: "read-2",
            command: "sed -n '1,80p' /repo/src/app.ts",
            itemType: "command_execution",
            requestKind: "command",
          }),
        },
      ],
      "/repo",
    );

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      kind: "work-summary",
      summary: {
        category: "search",
        label: "Explored 1 search, 2 files",
        items: [
          { label: "Searched for toolbar" },
          { label: "Read src/index.ts" },
          { label: "Read src/app.ts" },
        ],
      },
    });
  });

  it("keeps assistant messages visible inside work groups", () => {
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
