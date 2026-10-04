import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const drawerRenders = vi.hoisted(() => [] as Array<{ visible: boolean; threadRef: unknown }>);
vi.mock("~/components/ThreadTerminalDrawer", () => ({
  default: (props: { visible: boolean; threadRef: unknown }) => {
    drawerRenders.push({ visible: props.visible, threadRef: props.threadRef });
    return null;
  },
}));
vi.mock("~/state/entities", () => {
  const thread = { environmentId: "environment-a", projectId: "project-a", worktreePath: null };
  const project = { workspaceRoot: "/repo" };
  return { useThreadShell: () => thread, useProject: () => project };
});
vi.mock("~/state/terminalSessions", () => {
  const sessions: never[] = [];
  return { useKnownTerminalSessions: () => sessions };
});

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
  focusRequestId: 0,
  onAddTerminalContext: () => undefined,
  onSplitTerminal: () => undefined,
  onSplitTerminalVertical: () => undefined,
  onNewTerminal: () => undefined,
  onActiveTerminalChange: () => undefined,
  onCloseTerminal: () => undefined,
};

// ChatView builds a fresh host object on every render, as here.
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
  it("renders the host thread, skips rebuilt hosts with the same inputs, and follows visibility", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(panelIn(hostFor(true)));
    });
    expect(drawerRenders).toEqual([{ visible: true, threadRef }]);

    act(() => renderer!.update(panelIn(hostFor(true))));
    expect(drawerRenders).toHaveLength(1);

    act(() => renderer!.update(panelIn(hostFor(false))));
    expect(drawerRenders).toEqual([
      { visible: true, threadRef },
      { visible: false, threadRef },
    ]);
  });
});
