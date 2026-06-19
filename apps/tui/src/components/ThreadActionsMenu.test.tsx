import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { ThreadActionsMenu } from "./ThreadActionsMenu.tsx";

// Component specs for the ^K thread-actions overlay and its delete-confirm step.

async function frameOf(node: React.ReactNode): Promise<string> {
  const t = await testRender(node, { width: 70, height: 8 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

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
});
