import { render as renderScreen } from "../../../test/render";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const drawerRenders = vi.hoisted(() => [] as Array<{ visible: boolean; threadRef: unknown }>);
const drawerWorktreePaths = vi.hoisted(() => [] as Array<string | null>);
const thread = vi.hoisted(() => ({
  environmentId: "environment-a",
  projectId: "project-a",
  worktreePath: null as string | null,
}));
vi.mock("~/components/ThreadTerminalDrawer", () => ({
  default: (props: { visible: boolean; threadRef: unknown; worktreePath: string | null }) => {
    drawerRenders.push({ visible: props.visible, threadRef: props.threadRef });
    drawerWorktreePaths.push(props.worktreePath);
    return null;
  },
}));
vi.mock("~/state/entities", () => {
  const project = { workspaceRoot: "/repo" };
  return { useQuietThreadShell: () => thread, useProject: () => project };
});
const terminalSessions = vi.hoisted(
  () =>
    [] as Array<{
      target: { terminalId: string };
      state: { summary: { cwd: string; worktreePath: string | null } };
    }>,
);
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => terminalSessions,
}));

import type { RightPanelSurface } from "~/rightPanelStore";

import { PanelHostContext, type PanelHost } from "../panelHost";
import TerminalSidePanel from "./TerminalSidePanel";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const surface: Extract<RightPanelSurface, { kind: "terminal" }> = {
  id: "terminal:term-1",
  kind: "terminal",
  resourceId: "term-1",
  terminalIds: ["term-1"],
  activeTerminalId: "term-1",
};
const terminalProps = {
  surface,
  launchContext: null,
  onAddTerminalContext: () => undefined,
  onSplitTerminal: () => undefined,
  onSplitTerminalVertical: () => undefined,
  onNewTerminal: () => undefined,
  onActiveTerminalChange: () => undefined,
  onCloseTerminal: () => undefined,
};

// A host rebuilt with the same inputs, as here, must not re-render the drawer.
const hostFor = (visible: boolean): PanelHost => ({
  threadRef,
  visible,
  composerDraftTarget: threadRef,
  workspaceMutationId: null,
  sendAnnotation: () => undefined,
});
const panelIn = (host: PanelHost) => (
  <PanelHostContext value={host}>
    <TerminalSidePanel {...terminalProps} />
  </PanelHostContext>
);

describe("terminal side panel", () => {
  it("renders the host thread, skips rebuilt hosts with the same inputs, and follows visibility", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    await screen.rerender(panelIn(hostFor(true)));
    expect(drawerRenders).toEqual([{ visible: true, threadRef }]);

    await screen.rerender(panelIn(hostFor(true)));
    expect(drawerRenders).toHaveLength(1);

    await screen.rerender(panelIn(hostFor(false)));
    expect(drawerRenders).toEqual([
      { visible: true, threadRef },
      { visible: false, threadRef },
    ]);
  });

  it("keeps a local-checkout launch on the checkout after the thread gains a worktree", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    thread.worktreePath = "/repo/.worktrees/feature";
    drawerWorktreePaths.length = 0;
    const launchedLocally = (
      <PanelHostContext value={hostFor(true)}>
        <TerminalSidePanel
          {...terminalProps}
          launchContext={{ cwd: "/repo", worktreePath: null }}
        />
      </PanelHostContext>
    );
    await screen.rerender(launchedLocally);
    expect(drawerWorktreePaths).toEqual([null]);

    await screen.rerender(null);
    drawerWorktreePaths.length = 0;
    await screen.rerender(panelIn(hostFor(true)));
    expect(drawerWorktreePaths).toEqual(["/repo/.worktrees/feature"]);
    thread.worktreePath = null;
  });

  it("keeps a terminal the server opened on the checkout off the thread's later worktree", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    thread.worktreePath = "/repo/.worktrees/feature";
    terminalSessions.push({
      target: { terminalId: "term-1" },
      state: { summary: { cwd: "/repo", worktreePath: null } },
    });
    await screen.rerender(null);
    drawerWorktreePaths.length = 0;
    await screen.rerender(panelIn(hostFor(true)));
    expect(drawerWorktreePaths).toEqual([null]);
    terminalSessions.length = 0;
    thread.worktreePath = null;
  });
});

function resetFixture() {
  drawerRenders.length = 0;
  drawerWorktreePaths.length = 0;
  thread.worktreePath = null;
  terminalSessions.length = 0;
}
