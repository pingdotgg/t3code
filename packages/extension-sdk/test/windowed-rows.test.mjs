import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { useWindowedRows, windowedRowIndexes } from "../dist/authoring.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const host = { React };

/** Renders the hook for `count` rows of 20px; returns its latest answer. */
function mount(props) {
  const latest = { current: null };
  function List(props) {
    latest.current = useWindowedRows(host, { rowHeight: 20, ...props });
    return null;
  }
  let root;
  act(() => {
    root = create(React.createElement(List, props));
  });
  return {
    latest,
    update: (next) => act(() => root.update(React.createElement(List, next))),
    unmount: () => act(() => root.unmount()),
  };
}

NodeTest.describe("useWindowedRows", () => {
  NodeTest.it("mounts the rows near the viewport, however long the list", () => {
    const list = mount({ count: 25_000 });
    try {
      // Unmeasured, the viewport is taken as 800px: 40 rows plus 8 below.
      NodeAssert.equal(list.latest.current.indexes.length, 48);
      NodeAssert.equal(list.latest.current.height, 500_000);
      act(() => list.latest.current.onScroll({ currentTarget: { scrollTop: 250_000 } }));
      const indexes = list.latest.current.indexes;
      NodeAssert.deepEqual([indexes[0], indexes.at(-1)], [12_492, 12_547]);
    } finally {
      list.unmount();
    }
  });

  NodeTest.it("reveals a row by scrolling the least distance", () => {
    const list = mount({ count: 1000 });
    try {
      act(() => list.latest.current.reveal(999));
      NodeAssert.equal(list.latest.current.indexes.at(-1), 999);
      act(() => list.latest.current.reveal(990));
      NodeAssert.equal(list.latest.current.indexes.at(-1), 999, "already shown: no scroll");
      act(() => list.latest.current.reveal(0));
      NodeAssert.equal(list.latest.current.indexes[0], 0);
    } finally {
      list.unmount();
    }
  });

  NodeTest.it("keeps the focused row mounted, and follows a list that shrank", () => {
    const list = mount({ count: 1000, keep: 3 });
    try {
      act(() => list.latest.current.onScroll({ currentTarget: { scrollTop: 10_000 } }));
      NodeAssert.equal(list.latest.current.indexes[0], 3);
      NodeAssert.equal(list.latest.current.indexes[1], 492);
      list.update({ count: 10 });
      NodeAssert.deepEqual(list.latest.current.indexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      list.unmount();
    }
  });

  NodeTest.it("computes the window without React", () => {
    NodeAssert.deepEqual(
      windowedRowIndexes({
        count: 100,
        rowHeight: 10,
        scrollTop: 500,
        viewportHeight: 30,
        overscan: 1,
        keep: 99,
      }),
      [49, 50, 51, 52, 53, 99],
    );
  });
});
