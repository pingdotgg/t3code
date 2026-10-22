import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useRestingTopOffset } from "./useRestingTopOffset";

let root: Root | null = null;
let latest: ReturnType<typeof useRestingTopOffset> | null = null;

function Probe(props: { readonly topInset: number; readonly restoredOffset?: number }) {
  const restingOffset = useRestingTopOffset(
    props.topInset,
    props.restoredOffset === undefined ? {} : { contentOffset: { x: 0, y: props.restoredOffset } },
  );
  useLayoutEffect(() => {
    latest = restingOffset;
  });
  return null;
}

function render(topInset: number, restoredOffset?: number) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(<Probe topInset={topInset} restoredOffset={restoredOffset} />));
}

function scrollTo(y: number) {
  const event = { nativeEvent: { contentOffset: { x: 0, y } } } as Parameters<
    ReturnType<typeof useRestingTopOffset>["onScroll"]
  >[0];
  act(() => latest!.onScroll(event));
}

function offset() {
  return latest!.contentOffset.y;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
});

describe("useRestingTopOffset", () => {
  it("keeps an untouched list below the header once the column's inset arrives", () => {
    // The folded iPhone Duo's window has no top inset; the header's arrives after mount.
    render(0);
    render(54);
    expect(offset()).toBe(-54);
  });

  it("does not move a list the reader scrolled when the inset changes", () => {
    render(54);
    scrollTo(300);
    render(90);
    expect(offset()).toBe(-54);
  });

  it("follows the inset again once the list is back at the top", () => {
    render(54);
    scrollTo(300);
    render(90);
    scrollTo(-90);
    render(54);
    expect(offset()).toBe(-54);
  });

  it("holds a restored position through an inset change", () => {
    render(0, 1_200);
    render(54);
    expect(offset()).toBe(1_200);
  });
});
