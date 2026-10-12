import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, Suspense } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const loaded = vi.hoisted(() => ({
  diff: 0,
  preview: 0,
  terminal: 0,
  device: 0,
  pullRequest: 0,
  pullRequests: 0,
  files: 0,
  pluginView: 0,
  previewRenders: [] as unknown[],
}));
vi.mock("./diff/DiffSidePanel", () => {
  loaded.diff += 1;
  return { default: () => null };
});
vi.mock("./terminal/TerminalSidePanel", () => {
  loaded.terminal += 1;
  return { default: () => null };
});
vi.mock("./device/DeviceSidePanel", () => {
  loaded.device += 1;
  return { default: () => null };
});
vi.mock("./files/FilesSidePanel", () => {
  loaded.files += 1;
  return { default: () => null };
});
vi.mock("./pluginView/PluginViewSidePanel", () => {
  loaded.pluginView += 1;
  return { default: () => null };
});
vi.mock("./preview/PreviewSidePanel", () => {
  loaded.preview += 1;
  return {
    default: function PreviewSidePanel(props: unknown) {
      loaded.previewRenders.push({ props, host: usePanelHost() });
      return null;
    },
  };
});

vi.mock("./pullRequest/PullRequestSidePanel", () => {
  loaded.pullRequest += 1;
  return { default: () => null };
});
vi.mock("./pullRequest/PullRequestsSidePanel", () => {
  loaded.pullRequests += 1;
  return { default: () => null };
});

import type { RightPanelSurface } from "~/rightPanelStore";

import { RegisteredSidePanel } from "./bundledPanels";
import { PanelHostContext, usePanelHost, type PanelHost } from "./panelHost";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const host: PanelHost = {
  threadRef,
  visible: true,
  composerDraftTarget: threadRef,
  workspaceMutationId: null,
  sendAnnotation: () => undefined,
};

describe("bundled side panels", () => {
  it("loads only the selected panel body and lends it the host", async () => {
    expect(loaded).toMatchObject({
      diff: 0,
      preview: 0,
      terminal: 0,
      device: 0,
      pullRequest: 0,
      pullRequests: 0,
      files: 0,
      pluginView: 0,
    });
    await act(async () => {
      create(
        <PanelHostContext value={host}>
          <Suspense fallback={null}>
            <RegisteredSidePanel id="preview" tabId="tab-1" />
          </Suspense>
        </PanelHostContext>,
      );
    });
    expect(loaded).toMatchObject({
      diff: 0,
      preview: 1,
      terminal: 0,
      device: 0,
      pullRequest: 0,
      pullRequests: 0,
      files: 0,
      pluginView: 0,
    });
    expect(loaded.previewRenders).toEqual([{ props: { tabId: "tab-1" }, host }]);
  });

  it("loads only the terminal body when the terminal is selected", async () => {
    const surface: Extract<RightPanelSurface, { kind: "terminal" }> = {
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1"],
      activeTerminalId: "term-1",
    };
    await act(async () => {
      create(
        <PanelHostContext value={host}>
          <Suspense fallback={null}>
            <RegisteredSidePanel
              id="terminal"
              surface={surface}
              launchContext={null}
              focusRequestId={0}
              onAddTerminalContext={() => undefined}
              onSplitTerminal={() => undefined}
              onSplitTerminalVertical={() => undefined}
              onNewTerminal={() => undefined}
              onActiveTerminalChange={() => undefined}
              onCloseTerminal={() => undefined}
            />
          </Suspense>
        </PanelHostContext>,
      );
    });
    expect(loaded).toMatchObject({ diff: 0, terminal: 1 });
  });
});

const filesProps = {
  cwd: "/repo",
  projectName: "repo",
  relativePath: null,
  availableEditors: [],
  revealLine: null,
  revealRequestId: 0,
  onPendingChange: () => undefined,
  selectedFilePending: false,
};

// Never called. The project typecheck compiles these pairings, and each
// expect-error directive fails it if a wrong pairing starts to compile.
export function typeFixtures(
  widenedId: "diff" | "preview",
  terminalSurface: Extract<RightPanelSurface, { kind: "terminal" }>,
  deviceSurface: Extract<RightPanelSurface, { kind: "device" }>,
  pluginViewSurface: Extract<RightPanelSurface, { kind: "plugin-view" }>,
  dismiss: () => void,
) {
  const terminalProps = {
    surface: terminalSurface,
    launchContext: null,
    focusRequestId: 0,
    onAddTerminalContext: () => undefined,
    onSplitTerminal: () => undefined,
    onSplitTerminalVertical: () => undefined,
    onNewTerminal: () => undefined,
    onActiveTerminalChange: () => undefined,
    onCloseTerminal: () => undefined,
  };
  const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 7 };
  const pullRequest = {
    reference,
    context: "thread" as const,
    shortcutsEnabled: true,
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
  };
  return (
    <>
      <RegisteredSidePanel id="diff" />
      <RegisteredSidePanel id="preview" tabId="tab-1" configuredUrls={["http://localhost:3000"]} />
      <RegisteredSidePanel id="terminal" {...terminalProps} newShortcutLabel="⌘T" />
      {/* @ts-expect-error Terminal requires its surface and callbacks. */}
      <RegisteredSidePanel id="terminal" surface={terminalSurface} />
      {/* @ts-expect-error The host owns visibility; the terminal does not take it as a prop. */}
      <RegisteredSidePanel id="terminal" {...terminalProps} visible />
      {/* @ts-expect-error Terminal props on Preview. */}
      <RegisteredSidePanel id="preview" surface={terminalSurface} />
      <RegisteredSidePanel id="device" surface={deviceSurface} onDismissSetup={dismiss} />
      <RegisteredSidePanel id="pull-request" {...pullRequest} onBack={undefined} />
      <RegisteredSidePanel id="pull-requests" />
      {/* @ts-expect-error Pull request detail needs its reference and shortcut inputs. */}
      <RegisteredSidePanel id="pull-request" context="thread" />
      {/* @ts-expect-error Pull request props on the linked list. */}
      <RegisteredSidePanel id="pull-requests" reference={reference} />
      {/* @ts-expect-error Pull request props on Preview. */}
      <RegisteredSidePanel id="preview" shortcutsEnabled />
      {/* @ts-expect-error The host owns the composer draft target. */}
      <RegisteredSidePanel id="pull-request" {...pullRequest} composerDraftTarget={threadRef} />
      <RegisteredSidePanel id="files" {...filesProps} />
      {/* @ts-expect-error Files props on Preview. */}
      <RegisteredSidePanel id="preview" cwd="/repo" />
      {/* @ts-expect-error Files needs its surface inputs. */}
      <RegisteredSidePanel id="files" cwd="/repo" />
      {/* @ts-expect-error The host owns the composer draft target. */}
      <RegisteredSidePanel id="files" {...filesProps} composerDraftTarget={threadRef} />
      {/* @ts-expect-error Preview props on Diff. */}
      <RegisteredSidePanel id="diff" tabId="tab-1" />
      {/* @ts-expect-error Device props on Preview. */}
      <RegisteredSidePanel id="preview" surface={deviceSurface} />
      {/* @ts-expect-error Preview props on Device. */}
      <RegisteredSidePanel id="device" surface={deviceSurface} onDismissSetup={dismiss} tabId="1" />
      {/* @ts-expect-error Device needs its surface and setup dismissal. */}
      <RegisteredSidePanel id="device" />
      {/* @ts-expect-error The host owns visibility; panels do not take it as a prop. */}
      <RegisteredSidePanel id="device" surface={deviceSurface} onDismissSetup={dismiss} visible />
      {/* @ts-expect-error The host owns the thread; panels do not take it as a prop. */}
      <RegisteredSidePanel id="preview" threadRef={threadRef} />
      {/* @ts-expect-error Wrong input shape. */}
      <RegisteredSidePanel id="preview" configuredUrls="http://localhost:3000" />
      <RegisteredSidePanel id="plugin-view" surface={pluginViewSurface} />
      {/* @ts-expect-error A plugin view mounts only a plugin-view surface. */}
      <RegisteredSidePanel id="plugin-view" surface={terminalSurface} />
      {/* @ts-expect-error The host owns the environment; the view does not take it as a prop. */}
      <RegisteredSidePanel id="plugin-view" surface={pluginViewSurface} threadRef={threadRef} />
      {/* @ts-expect-error Unknown id. */}
      <RegisteredSidePanel id="not-a-panel" />
      {/* @ts-expect-error A widened id cannot borrow one panel's props. */}
      <RegisteredSidePanel id={widenedId} tabId="tab-1" />
    </>
  );
}
