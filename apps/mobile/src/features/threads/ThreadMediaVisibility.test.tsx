import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const viewability = vi.hoisted(() => ({
  callbacks: new Set<(token: { sizeVisible: number }) => void>(),
  sizeVisible: 0,
}));

vi.mock("@legendapp/list/react-native", () => ({
  useViewabilityAmount(callback: (token: { sizeVisible: number }) => void) {
    useEffect(() => {
      viewability.callbacks.add(callback);
      callback({ sizeVisible: viewability.sizeVisible });
      return () => {
        viewability.callbacks.delete(callback);
      };
    }, [callback]);
  },
}));

import { ThreadMediaVisibility, useThreadMediaVisible } from "./ThreadMediaVisibility";

let root: Root;
let container: HTMLDivElement;

function Video(props: { readonly override?: boolean }) {
  const visible = useThreadMediaVisible(props.override);
  return <span>{visible ? "thumbnail active" : "thumbnail paused"}</span>;
}

function scroll(sizeVisible: number) {
  viewability.sizeVisible = sizeVisible;
  act(() => {
    for (const callback of viewability.callbacks) callback({ sizeVisible });
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  viewability.sizeVisible = 0;
});

afterEach(() => {
  act(() => root.unmount());
  expect(viewability.callbacks.size).toBe(0);
});

describe("thread media visibility", () => {
  it("does not observe text-only rows", () => {
    act(() =>
      root.render(
        Array.from({ length: 100 }, (_, index) => (
          <ThreadMediaVisibility key={index}>Message {index}</ThreadMediaVisibility>
        )),
      ),
    );
    expect(container.textContent).toContain("Message 99");
    expect(viewability.callbacks.size).toBe(0);
    scroll(100);
    expect(viewability.callbacks.size).toBe(0);
  });

  it("shares one observer between videos and releases it after the last video leaves", () => {
    const render = (count: number) =>
      act(() =>
        root.render(
          <ThreadMediaVisibility>
            {Array.from({ length: count }, (_, index) => (
              <Video key={index} />
            ))}
          </ThreadMediaVisibility>,
        ),
      );
    render(2);
    expect(viewability.callbacks.size).toBe(1);
    expect(container.textContent).toBe("thumbnail pausedthumbnail paused");
    scroll(50);
    expect(container.textContent).toBe("thumbnail activethumbnail active");
    render(1);
    expect(viewability.callbacks.size).toBe(1);
    scroll(0);
    expect(container.textContent).toBe("thumbnail paused");
    render(0);
    expect(viewability.callbacks.size).toBe(0);
    viewability.sizeVisible = 50;
    render(1);
    expect(container.textContent).toBe("thumbnail active");
  });

  it("uses explicit visibility outside a feed without registering an observer", () => {
    act(() =>
      root.render(
        <>
          <Video override />
          <Video override={false} />
          <Video />
        </>,
      ),
    );
    expect(container.textContent).toBe("thumbnail activethumbnail pausedthumbnail paused");
    expect(viewability.callbacks.size).toBe(0);
  });

  it("unsubscribes when a feed video switches to explicit visibility", () => {
    act(() =>
      root.render(
        <ThreadMediaVisibility>
          <Video />
        </ThreadMediaVisibility>,
      ),
    );
    scroll(50);
    act(() =>
      root.render(
        <ThreadMediaVisibility>
          <Video override={false} />
        </ThreadMediaVisibility>,
      ),
    );
    expect(container.textContent).toBe("thumbnail paused");
    expect(viewability.callbacks.size).toBe(0);
  });
});

it("keeps a replacement keyed video visible without another scroll event", () => {
  const renderVideo = (key: string) =>
    act(() =>
      root.render(
        <ThreadMediaVisibility>
          <Video key={key} />
        </ThreadMediaVisibility>,
      ),
    );
  renderVideo("first");
  scroll(50);
  expect(container.textContent).toBe("thumbnail active");
  renderVideo("replacement");
  expect(container.textContent).toBe("thumbnail active");
  expect(viewability.callbacks.size).toBe(1);
});
