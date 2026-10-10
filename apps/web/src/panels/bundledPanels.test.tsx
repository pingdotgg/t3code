import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, Suspense } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const loaded = vi.hoisted(() => ({ diff: 0, preview: 0, previewRenders: [] as unknown[] }));
vi.mock("./diff/DiffSidePanel", () => {
  loaded.diff += 1;
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
    expect(loaded).toMatchObject({ diff: 0, preview: 0 });
    await act(async () => {
      create(
        <PanelHostContext value={host}>
          <Suspense fallback={null}>
            <RegisteredSidePanel id="preview" tabId="tab-1" />
          </Suspense>
        </PanelHostContext>,
      );
    });
    expect(loaded).toMatchObject({ diff: 0, preview: 1 });
    expect(loaded.previewRenders).toEqual([{ props: { tabId: "tab-1" }, host }]);
  });
});

// Never called. The project typecheck compiles these pairings, and each
// expect-error directive fails it if a wrong pairing starts to compile.
export function typeFixtures(widenedId: "diff" | "preview") {
  return (
    <>
      <RegisteredSidePanel id="diff" />
      <RegisteredSidePanel id="preview" tabId="tab-1" configuredUrls={["http://localhost:3000"]} />
      {/* @ts-expect-error Preview props on Diff. */}
      <RegisteredSidePanel id="diff" tabId="tab-1" />
      {/* @ts-expect-error The host owns the thread; panels do not take it as a prop. */}
      <RegisteredSidePanel id="preview" threadRef={threadRef} />
      {/* @ts-expect-error Wrong input shape. */}
      <RegisteredSidePanel id="preview" configuredUrls="http://localhost:3000" />
      {/* @ts-expect-error Unknown id. */}
      <RegisteredSidePanel id="terminal" />
      {/* @ts-expect-error A widened id cannot borrow one panel's props. */}
      <RegisteredSidePanel id={widenedId} tabId="tab-1" />
    </>
  );
}
