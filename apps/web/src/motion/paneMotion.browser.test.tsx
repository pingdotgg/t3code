import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import {
  createLayoutState,
  openLayoutTab,
  selectFocusedTab,
  type LayoutTab,
} from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { usePaneMotion } from "./paneMotion";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread"));

const placedAt = (index: number) =>
  ({ position: "absolute", top: 0, left: index * 316, width: 300, height: 200 }) as const;

function DiffContent() {
  return (
    <div
      ref={(node) => {
        const line = document.createElement("div");
        line.textContent = "diff line";
        node?.append(line);
        return () => line.remove();
      }}
    />
  );
}

function Strip() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const layout = useLayoutStore((state) => state.layout);
  const tabs = layout.workspaces[0]!.columns.map((column) => column.panes[0]!.tabs[0]!);
  const key = tabs.map((tab) => tab.id).join();
  const [drawn, setDrawn] = useState<{ key: string; tabs: LayoutTab[] }>({ key, tabs });
  const [ghosts, setGhosts] = useState<{ tabId: string; index: number }[]>([]);
  if (drawn.key !== key) {
    setDrawn({ key, tabs });
    setGhosts(
      drawn.tabs.flatMap((tab, index) =>
        tabs.some((open) => open.id === tab.id) ? [] : [{ tabId: tab.id, index }],
      ),
    );
  }
  usePaneMotion(stageRef, "strip", true, () => {}, key);
  return (
    <div ref={stageRef} style={{ position: "relative", isolation: "isolate", height: 200 }}>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          data-layout-tab-id={tab.id}
          data-layout-pane-id={tab.id}
          data-layout-surface={tab.content.kind === "surface" ? "diff" : undefined}
          style={placedAt(index)}
        >
          {tab.content.kind === "surface" ? <DiffContent /> : "chat"}
        </div>
      ))}
      {ghosts.map(({ tabId, index }) => (
        <div key={`ghost-${tabId}`} data-layout-closing={tabId} style={placedAt(index)} />
      ))}
    </div>
  );
}

describe("usePaneMotion", () => {
  it("slides a closed surface away showing what it drew before React tore it down", async () => {
    const withDiff = openLayoutTab(
      openLayoutTab(createLayoutState(), { kind: "chat", target: { kind: "server", threadRef } }),
      { kind: "surface", threadRef, surfaceId: "diff" },
      { placement: "new-column" },
    );
    const diffTabId = selectFocusedTab(withDiff)!.id;
    useLayoutStore.setState({ layout: withDiff });
    await using screen = await render(<Strip />);

    flushSync(() => useLayoutStore.getState().closeTab(diffTabId));

    const ghost = screen.container.querySelector(`[data-layout-closing="${diffTabId}"]`);
    expect(screen.container.querySelector(`[data-layout-tab-id="${diffTabId}"]`)).toBeNull();
    expect(ghost?.textContent).toBe("diff line");
  });
});
