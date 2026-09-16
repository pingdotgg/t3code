import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PullRequestsColumn } from "./_chat.pull-requests";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  // Same stub shape as useComposerMenuState.test.tsx: no DOM, just an event target.
  // react-test-renderer needs no host nodes, but the column's effects touch
  // window and IntersectionObserver, so those get minimal no-op stubs.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("PullRequestsColumn partitions intent", () => {
  it("forwards pointer and focus warmers to onPartitionsIntent", async () => {
    const onPartitionsIntent = vi.fn();
    await act(() => {
      renderer = create(
        <PullRequestsColumn
          refreshing={false}
          onRefresh={() => {}}
          searchValue=""
          involvement="all"
          state="open"
          host={undefined}
          hostMenuOptions={[]}
          onInvolvement={() => {}}
          onPartitionsIntent={onPartitionsIntent}
          onState={() => {}}
          onHost={() => {}}
          searchInput={null}
          sortMenu={null}
          filtersMenu={null}
          rightPanelControl={null}
          titlebarControls={null}
          rightPanelOpen={false}
          listBody={null}
          scrollRef={{ current: null }}
        />,
      );
    });

    const outer = renderer!.root.findAllByType("div")[0]!;
    expect(typeof outer.props.onPointerEnter).toBe("function");
    expect(typeof outer.props.onFocusCapture).toBe("function");

    await act(() => {
      outer.props.onPointerEnter();
    });
    expect(onPartitionsIntent).toHaveBeenCalledTimes(1);

    await act(() => {
      outer.props.onFocusCapture();
    });
    expect(onPartitionsIntent).toHaveBeenCalledTimes(2);
  });
});
