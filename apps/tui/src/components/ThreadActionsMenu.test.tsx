import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { RevertMenu, ThreadActionsMenu } from "./ThreadActionsMenu.tsx";

// Component specs for the ^K thread-actions overlay, its delete-confirm step, and
// the checkpoint-revert picker.

async function frameOf(node: React.ReactNode): Promise<string> {
  const t = await testRender(node, { width: 70, height: 10 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

const checkpoint = (turnCount: number, files: number, completedAt: string) =>
  ({
    turnId: `t${turnCount}`,
    checkpointTurnCount: turnCount,
    completedAt,
    files: Array.from({ length: files }, (_, i) => ({
      path: `f${i}`,
      kind: "file",
      additions: 1,
      deletions: 0,
    })),
  }) as never;

describe("ThreadActionsMenu", () => {
  it("Given the actions overlay for a live thread, then it lists rename/archive/delete/stop", async () => {
    const frame = await frameOf(
      <ThreadActionsMenu overlay="actions" title="My thread" archived={false} sessionRunning />,
    );
    expect(frame).toContain("rename");
    expect(frame).toContain("archive");
    expect(frame).toContain("delete");
    expect(frame).toContain("stop");
  });

  it("Given an archived thread, then the archive action reads 'unarchive'", async () => {
    const frame = await frameOf(
      <ThreadActionsMenu overlay="actions" title="Old" archived sessionRunning={false} />,
    );
    expect(frame).toContain("unarchive");
  });

  it("Given the confirm-delete overlay, then it warns and offers y/n", async () => {
    const frame = await frameOf(
      <ThreadActionsMenu overlay="confirmDelete" title="Doomed" archived={false} sessionRunning={false} />,
    );
    expect(frame).toContain("delete");
    expect(frame).toContain("can't be undone");
    expect(frame).toContain("y delete");
  });

  it("Given the actions overlay, then it lists the revert action", async () => {
    const frame = await frameOf(
      <ThreadActionsMenu overlay="actions" title="My thread" archived={false} sessionRunning />,
    );
    expect(frame).toContain("revert");
  });
});

describe("RevertMenu", () => {
  it("Given checkpoints, then it lists turns with file counts and highlights the selection", async () => {
    const frame = await frameOf(
      <RevertMenu
        checkpoints={[
          checkpoint(3, 2, "2026-06-19T00:00:09.000Z"),
          checkpoint(2, 1, "2026-06-19T00:00:05.000Z"),
        ]}
        selected={1}
      />,
    );
    expect(frame).toContain("turn 3 · 2 files");
    expect(frame).toContain("turn 2 · 1 file");
    expect(frame).toContain("discards changes made after it");
    expect(frame).toContain("▸ turn 2");
  });
});
