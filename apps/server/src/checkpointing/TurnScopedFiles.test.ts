import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveTurnScopedCheckpointFiles } from "./TurnScopedFiles.ts";

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
    });
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
    });
  });
});
