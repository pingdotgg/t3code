import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkLogDetails } from "./WorkLog";

const VIEWPORT = 384;

// Stand-in for the measured scroll geometry; react-test-renderer has no layout.
const mockEl = {
  scrollHeight: 1000,
  clientHeight: VIEWPORT,
  scrollTop: 0,
};

let renderer: ReactTestRenderer;
let followLive = true;

function scroller() {
  return renderer.root.findByType("div");
}

function mount() {
  mockEl.scrollHeight = 1000;
  mockEl.scrollTop = 0;
  act(() => {
    renderer = create(
      <WorkLogDetails followLive={followLive}>
        <p>reasoning</p>
      </WorkLogDetails>,
      { createNodeMock: () => mockEl },
    );
  });
}

function streamMore() {
  mockEl.scrollHeight += 500;
  act(() => {
    renderer.update(
      <WorkLogDetails followLive={followLive}>
        <p>{"reasoning\n".repeat(100)}</p>
      </WorkLogDetails>,
    );
  });
}

function userScrollsTo(top: number) {
  mockEl.scrollTop = top;
  act(() => {
    scroller().props.onScroll({ currentTarget: mockEl });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  followLive = true;
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("WorkLogDetails followLive", () => {
  it("pins the scroller to the end as live content grows", () => {
    mount();
    streamMore();
    expect(mockEl.scrollTop).toBe(mockEl.scrollHeight);
    streamMore();
    expect(mockEl.scrollTop).toBe(mockEl.scrollHeight);
  });

  it("holds position once the reader scrolls away from the end", () => {
    mount();
    streamMore();
    expect(mockEl.scrollTop).toBe(mockEl.scrollHeight);

    userScrollsTo(100);
    streamMore();
    expect(mockEl.scrollTop).toBe(100);
  });

  it("re-pins after the reader scrolls back to the end", () => {
    mount();
    userScrollsTo(100);
    streamMore();
    expect(mockEl.scrollTop).toBe(100);

    userScrollsTo(mockEl.scrollHeight - VIEWPORT);
    streamMore();
    expect(mockEl.scrollTop).toBe(mockEl.scrollHeight);
  });

  it("does not move the scroller when followLive is off", () => {
    followLive = false;
    mount();
    streamMore();
    expect(mockEl.scrollTop).toBe(0);
  });
});
