import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, Suspense } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const loaded = vi.hoisted(() => ({
  diff: 0,
  preview: 0,
  terminal: 0,
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
vi.mock("./preview/PreviewSidePanel", () => {
  loaded.preview += 1;
  return {
    default: function PreviewSidePanel(props: unknown) {
      loaded.previewRenders.push({ props, host: usePanelHost() });
      return null;
    },
  };
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
    expect(loaded).toMatchObject({ diff: 0, preview: 0, terminal: 0 });
    await act(async () => {
      create(
        <PanelHostContext value={host}>
          <Suspense fallback={null}>
            <RegisteredSidePanel id="preview" tabId="tab-1" />
          </Suspense>
        </PanelHostContext>,
      );
    });
    expect(loaded).toMatchObject({ diff: 0, preview: 1, terminal: 0 });
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

// Never called. The project typecheck compiles these pairings, and each
// expect-error directive fails it if a wrong pairing starts to compile.
export function typeFixtures(
  widenedId: "diff" | "preview",
  terminalSurface: Extract<RightPanelSurface, { kind: "terminal" }>,
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
      {/* @ts-expect-error Preview props on Diff. */}
      <RegisteredSidePanel id="diff" tabId="tab-1" />
      {/* @ts-expect-error The host owns the thread; panels do not take it as a prop. */}
      <RegisteredSidePanel id="preview" threadRef={threadRef} />
      {/* @ts-expect-error Wrong input shape. */}
      <RegisteredSidePanel id="preview" configuredUrls="http://localhost:3000" />
      {/* @ts-expect-error Unknown id. */}
      <RegisteredSidePanel id="not-a-panel" />
      {/* @ts-expect-error A widened id cannot borrow one panel's props. */}
      <RegisteredSidePanel id={widenedId} tabId="tab-1" />
    </>
  );
}
