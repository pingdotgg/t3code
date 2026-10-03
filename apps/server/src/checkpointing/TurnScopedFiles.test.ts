import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveTurnScopedCheckpointFiles, MAX_TURN_SCOPED_PATHS } from "./TurnScopedFiles.ts";

function makeActivity(input: {
  readonly id: string;
  readonly kind: string;
  readonly turnId: TurnId | null;
  readonly payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    kind: input.kind,
    tone: "tool",
    summary: "Tool",
    payload: input.payload,
    turnId: input.turnId,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("deriveTurnScopedCheckpointFiles", () => {
  it("intersects normalized agent-touched paths with snapshot files for the selected turn", () => {
    const turnId = TurnId.make("turn-1");
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      snapshotFiles: [
        { path: "src/app.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "src/other.ts", kind: "modified", additions: 1, deletions: 0 },
      ],
      activities: [
        makeActivity({
          id: "activity-1",
          kind: "tool.completed",
          turnId,
          payload: {
            itemType: "file_change",
            data: { filePath: "./src\\app.ts" },
          },
        }),
        makeActivity({
          id: "activity-2",
          kind: "tool.completed",
          turnId: TurnId.make("turn-2"),
          payload: { data: { filePath: "src/other.ts" } },
        }),
      ],
    });

    expect(result).toEqual({
      agentTouchedPaths: ["src/app.ts"],
      turnFiles: [{ path: "src/app.ts", kind: "modified", additions: 2, deletions: 1 }],
      truncated: false,
    });
  });

  it("uses provider diff paths before falling back to tool activity paths", () => {
    const turnId = TurnId.make("turn-1");
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      providerTouchedPaths: ["apps/web/src/components/Sidebar.tsx"],
      snapshotFiles: [
        {
          path: "apps/web/src/components/Sidebar.tsx",
          kind: "modified",
          additions: 1,
          deletions: 37,
        },
        { path: "src/other.ts", kind: "modified", additions: 1, deletions: 0 },
      ],
      activities: [],
    });

    expect(result).toEqual({
      agentTouchedPaths: ["apps/web/src/components/Sidebar.tsx"],
      turnFiles: [
        {
          path: "apps/web/src/components/Sidebar.tsx",
          kind: "modified",
          additions: 1,
          deletions: 37,
        },
      ],
      truncated: false,
    });
  });

  it("keeps touched-path provenance even when there is no net checkpoint diff", () => {
    const turnId = TurnId.make("turn-1");
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      snapshotFiles: [],
      activities: [
        makeActivity({
          id: "activity-1",
          kind: "tool.updated",
          turnId,
          payload: {
            itemType: "file_change",
            data: { filePath: "/repo/src/reverted.ts" },
          },
        }),
      ],
    });

    expect(result).toEqual({
      agentTouchedPaths: ["src/reverted.ts"],
      turnFiles: [],
      truncated: false,
    });
  });

  it("does not attribute an existing workspace diff to a file read", () => {
    const turnId = TurnId.make("turn-1");
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      snapshotFiles: [
        {
          path: "apps/web/src/components/ChatView.tsx",
          kind: "modified",
          additions: 2,
          deletions: 78,
        },
      ],
      activities: [
        makeActivity({
          id: "activity-read-chat-view",
          kind: "tool.completed",
          turnId,
          payload: {
            itemType: "dynamic_tool_call",
            data: {
              copilotToolName: "view",
              kind: "other",
              rawInput: {
                path: "/repo/apps/web/src/components/ChatView.tsx",
              },
            },
          },
        }),
      ],
    });

    expect(result).toEqual({
      agentTouchedPaths: [],
      turnFiles: [],
      truncated: false,
    });
  });

  it("reports truncation instead of silently capping touched paths", () => {
    const turnId = TurnId.make("turn-1");
    const snapshotFiles = Array.from({ length: 600 }, (_, index) => ({
      path: `src/file-${String(index).padStart(4, "0")}.ts`,
      kind: "modified" as const,
      additions: 1,
      deletions: 0,
    }));
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      snapshotFiles,
      activities: snapshotFiles.slice(0, 600).map((file) =>
        makeActivity({
          id: `activity-${file.path}`,
          kind: "tool.completed",
          turnId,
          payload: { itemType: "file_change", data: { filePath: file.path } },
        }),
      ),
    });

    expect(result.turnFiles.length).toBe(MAX_TURN_SCOPED_PATHS);
    expect(result.truncated).toBe(true);
  });

  it("reports no truncation for a small turn", () => {
    const turnId = TurnId.make("turn-1");
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      snapshotFiles: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
      activities: [
        makeActivity({
          id: "activity-1",
          kind: "tool.completed",
          turnId,
          payload: { itemType: "file_change", data: { filePath: "src/app.ts" } },
        }),
      ],
    });

    expect(result.truncated).toBe(false);
  });

  it("rejects unsafe provider paths before deriving turn files", () => {
    const turnId = TurnId.make("turn-1");
    const result = deriveTurnScopedCheckpointFiles({
      cwd: "/repo",
      turnId,
      snapshotFiles: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
      activities: [
        makeActivity({
          id: "activity-1",
          kind: "tool.completed",
          turnId,
          payload: {
            itemType: "file_change",
            data: {
              files: [
                { path: ":!src/secret.ts" },
                { path: "../outside.ts" },
                { path: "src/\napp.ts" },
              ],
            },
          },
        }),
      ],
    });

    expect(result).toEqual({
      agentTouchedPaths: [],
      turnFiles: [],
      truncated: false,
    });
  });
});
