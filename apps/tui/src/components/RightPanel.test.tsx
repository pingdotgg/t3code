import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { VcsStatusResult } from "@t3tools/contracts";
import { RightPanel } from "./RightPanel.tsx";

const status = (over: Partial<VcsStatusResult>): VcsStatusResult =>
  ({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/login",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...over,
  }) as unknown as VcsStatusResult;

const openPr = {
  number: 42,
  title: "Login",
  url: "https://example/pr/42",
  baseRef: "main",
  headRef: "feature/login",
  state: "open",
};

async function render(node: React.ReactNode) {
  const t = await testRender(node, { width: 40, height: 16 });
  await t.renderOnce();
  await t.flush();
  return t;
}

describe("RightPanel", () => {
  it("Given no git status, then it shows a placeholder", async () => {
    const t = await render(
      <RightPanel status={null} busy={false} width={32} height={14} onRunAction={() => {}} onOpenUrl={() => {}} />,
    );
    expect(t.captureCharFrame()).toContain("no git status");
    t.renderer.destroy();
  });

  it("Given a feature branch ahead with no PR, then it offers Push & create PR and runs it on click", async () => {
    const actions: string[] = [];
    const t = await render(
      <RightPanel
        status={status({ aheadCount: 2 })}
        busy={false}
        width={32}
        height={14}
        onRunAction={(a) => actions.push(a)}
        onOpenUrl={() => {}}
      />,
    );
    const frame = t.captureCharFrame();
    expect(frame).toContain("feature/login");
    expect(frame).toContain("Push & create PR");
    expect(frame).toContain("Create PR");
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("Push & create PR"));
    const col = (lines[row] ?? "").indexOf("Push") + 1;
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(actions).toEqual(["create_pr"]);
    t.renderer.destroy();
  });

  it("Given an open PR, then it shows PR status and View PR opens the url", async () => {
    const opened: string[] = [];
    const t = await render(
      <RightPanel
        status={status({ pr: openPr as never })}
        busy={false}
        width={32}
        height={14}
        onRunAction={() => {}}
        onOpenUrl={(url) => opened.push(url)}
      />,
    );
    const frame = t.captureCharFrame();
    expect(frame).toContain("PR #42");
    expect(frame).toContain("View PR");
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("▸") && line.includes("View PR"));
    const col = (lines[row] ?? "").indexOf("View") + 1;
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(opened).toEqual(["https://example/pr/42"]);
    t.renderer.destroy();
  });
});
