import { Activity, act, useImperativeHandle, useRef, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useSearchScrollRestoration } from "./useSearchScrollRestoration";
import type { WorkspaceSearchMode } from "./workspace-tabs-state";

it("preserves the live scroll position across Activity reconnections and restores cancelled search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  let liveOffset = 0;
  let connections = 0;
  let disconnections = 0;
  const scroll = vi.fn((offset: number) => {
    liveOffset = offset;
  });
  type ListHandle = { scrollToOffset: (offset: number) => void };
  function List({ ref }: { ref: Ref<ListHandle> }) {
    useImperativeHandle(ref, () => {
      connections += 1;
      return { scrollToOffset: scroll };
    });
    return (
      <div
        ref={(node) => {
          if (node === null) disconnections += 1;
        }}
      >
        List
      </div>
    );
  }
  function Screen(props: {
    searchMode: WorkspaceSearchMode | undefined;
    savedOffset: number;
    inset: number;
  }) {
    const list = useRef<ListHandle>(null);
    useSearchScrollRestoration(props.searchMode, () => {
      list.current?.scrollToOffset(props.savedOffset - props.inset);
    });
    return <List ref={list} />;
  }
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const input: Parameters<typeof Screen>[0] = {
    searchMode: "resting",
    savedOffset: 0,
    inset: 0,
  };
  const render = async (visible: boolean) => {
    await act(async () =>
      root.render(
        <Activity mode={visible ? "visible" : "hidden"}>
          <Screen {...input} />
        </Activity>,
      ),
    );
  };

  await render(true);
  expect(scroll).not.toHaveBeenCalled();
  liveOffset = 640;
  await render(false);
  expect(disconnections).toBeGreaterThan(0);
  const connectionsBeforeReturn = connections;
  await render(true);
  expect(connections).toBeGreaterThan(connectionsBeforeReturn);
  expect(liveOffset).toBe(640);
  expect(scroll).not.toHaveBeenCalled();

  input.searchMode = "active";
  input.savedOffset = liveOffset;
  await render(true);
  input.searchMode = "expanded";
  await render(true);
  liveOffset = 0;
  input.searchMode = "resting";
  input.inset = 24;
  await render(true);
  expect(liveOffset).toBe(616);
  expect(scroll.mock.calls).toEqual([[616]]);

  liveOffset = 1280;
  input.inset = 48;
  await render(true);
  await render(false);
  await render(true);
  expect(liveOffset).toBe(1280);
  expect(scroll.mock.calls).toEqual([[616]]);

  input.searchMode = undefined;
  await render(true);
  input.searchMode = "resting";
  await render(true);
  expect(scroll.mock.calls).toEqual([[616]]);
});
