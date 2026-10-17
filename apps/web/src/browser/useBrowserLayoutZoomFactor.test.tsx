import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBrowserLayoutZoomFactor } from "./useBrowserLayoutZoomFactor";

let windowZoomFactor = 1;
let renderer: ReactTestRenderer | undefined;
const seen: number[] = [];

function Probe(props: { readonly previewZoomFactor: number }) {
  seen.push(useBrowserLayoutZoomFactor(props.previewZoomFactor));
  return null;
}

beforeEach(() => {
  windowZoomFactor = 1;
  seen.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: { getWindowZoomFactor: () => windowZoomFactor },
    }),
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useBrowserLayoutZoomFactor", () => {
  it("follows an app window zoom change made after mount", async () => {
    await act(() => {
      renderer = create(<Probe previewZoomFactor={1} />);
    });
    expect(seen.at(-1)).toBe(1);

    // View > Zoom In once, which Chromium reports to the page as a resize.
    windowZoomFactor = 1.2 ** 0.5;
    await act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(seen.at(-1)).toBeCloseTo(1 / 1.2 ** 0.5, 6);

    windowZoomFactor = 1;
    await act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(seen.at(-1)).toBe(1);
  });

  it("falls back to the preview zoom alone when the desktop shell lacks the bridge method", async () => {
    vi.stubGlobal("window", new EventTarget());
    await act(() => {
      renderer = create(<Probe previewZoomFactor={1.25} />);
    });
    expect(seen.at(-1)).toBe(1.25);
  });
});
