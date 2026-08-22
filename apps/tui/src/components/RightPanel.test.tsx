import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { VcsStatusResult } from "@t3tools/contracts";
import { buildGitPanelActions, type GitPanelAction } from "../gitActions.logic.ts";
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

async function renderPanel({
  vcsStatus,
  busy = false,
  selectedIndex = 0,
  focused = true,
  onActivate = () => {},
}: {
  vcsStatus: VcsStatusResult | null;
  busy?: boolean;
  selectedIndex?: number;
  focused?: boolean;
  onActivate?: (action: GitPanelAction) => void;
}) {
  const actions = buildGitPanelActions(vcsStatus, busy);
  const t = await testRender(
    <RightPanel
      status={vcsStatus}
      busy={busy}
      actions={actions}
      selectedIndex={selectedIndex}
      focused={focused}
      width={36}
      height={16}
      onSelect={() => {}}
      onActivate={onActivate}
    />,
    { width: 42, height: 18 },
  );
  await t.renderOnce();
  await t.flush();
  return t;
}

describe("RightPanel", () => {
  it("Given no git status, then it explains why the primary action is disabled", async () => {
    const t = await renderPanel({ vcsStatus: null });
    const frame = t.captureCharFrame();
    expect(frame).toContain("no git status");
    expect(frame).toContain("Git status is unavailable");
    t.renderer.destroy();
  });

  it("Given changed files, then it shows sync and change counts", async () => {
    const t = await renderPanel({
      vcsStatus: status({
        aheadCount: 2,
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [
            { path: "a.ts", insertions: 3, deletions: 0 },
            { path: "b.ts", insertions: 2, deletions: 1 },
          ],
          insertions: 5,
          deletions: 1,
        },
      }),
    });
    const frame = t.captureCharFrame();
    expect(frame).toContain("↑2 upstream");
    expect(frame).toContain("2 files · +5 -1");
    t.renderer.destroy();
  });

  it("Given a feature branch ahead with no PR, then clicking the primary action runs it", async () => {
    const activated: GitPanelAction[] = [];
    const t = await renderPanel({
      vcsStatus: status({ aheadCount: 2 }),
      onActivate: (action) => activated.push(action),
    });
    const frame = t.captureCharFrame();
    expect(frame).toContain("feature/login");
    expect(frame).toContain("Push & create PR");
    expect(frame).toContain("Create PR");
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("Push & create PR"));
    const col = (lines[row] ?? "").indexOf("Push") + 1;
    await t.mockMouse.click(col, row);
    await Bun.sleep(0);
    await t.flush();
    expect(activated[0]).toMatchObject({ kind: "git", action: "create_pr" });
    t.renderer.destroy();
  });

  it("Given an open PR, then it renders and activates its URL action", async () => {
    const activated: GitPanelAction[] = [];
    const t = await renderPanel({
      vcsStatus: status({ pr: openPr as never }),
      onActivate: (action) => activated.push(action),
    });
    const frame = t.captureCharFrame();
    expect(frame).toContain("PR #42");
    expect(frame).toContain("View PR");
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("▸") && line.includes("View PR"));
    const col = (lines[row] ?? "").indexOf("View") + 1;
    await t.mockMouse.click(col, row);
    await Bun.sleep(0);
    await t.flush();
    expect(activated[0]).toMatchObject({ kind: "url", url: "https://example/pr/42" });
    t.renderer.destroy();
  });

  it("Given a disabled contextual action is selected, then it shows the reason", async () => {
    const t = await renderPanel({
      vcsStatus: status({ behindCount: 2 }),
      selectedIndex: 2,
    });
    expect(t.captureCharFrame()).toContain("Pull or rebase before pushing");
    t.renderer.destroy();
  });
});
