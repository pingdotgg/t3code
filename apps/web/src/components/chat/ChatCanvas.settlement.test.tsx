import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatWorkspaceGeometryContext } from "../ChatWorkspace";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";

let renderer: ReactTestRenderer;
let context: ReturnType<typeof useChatCanvas>;
let resized: () => void;
const resize = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (
    _elements: unknown,
    callback: (entries: { contentRect: { width: number } }[]) => void,
  ) => {
    const notify = () => callback([{ contentRect: { width: 0 } }]);
    resize.callbacks.add(notify);
    return () => resize.callbacks.delete(notify);
  },
}));
let width = 900;
const canvas = {
  get clientWidth() {
    return width;
  },
  clientHeight: 900,
  querySelectorAll: () => [],
  querySelector: () => null,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
};

function mockElement({ props }: { props: unknown }) {
  if (props && typeof props === "object" && "data-chat-reservation-source" in props) {
    return { getBoundingClientRect: () => ({ width: 0 }) };
  }
  return props && typeof props === "object" && "data-chat-canvas" in props ? canvas : {};
}

function ReadCard() {
  const card = useChatCanvas();
  useLayoutEffect(() => {
    context = card;
  }, [card]);
  return null;
}

function Workspace({ destination = 900, moving = false }) {
  return (
    <ChatWorkspaceGeometryContext
      value={{ width: destination, dockingWidth: 900, moving, onMeasured: () => {} }}
    >
      <ChatCanvas composerOverlayElement={null}>
        <ReadCard />
      </ChatCanvas>
    </ChatWorkspaceGeometryContext>
  );
}

beforeEach(() => {
  width = 900;
  resized = () => {
    for (const callback of resize.callbacks) callback();
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("getComputedStyle", () => ({
    paddingLeft: "48px",
    width: "736px",
    minWidth: "640px",
    getPropertyValue: () => "736px",
  }));
});

afterEach(async () => {
  await act(() => renderer.unmount());
  resize.callbacks.clear();
  vi.unstubAllGlobals();
});

describe("workspace card settlement", () => {
  it.each([
    { destination: 1521, actual: 1522, x: 1230 },
    { destination: 1011, actual: 1012, x: 720 },
    { destination: 1012, actual: 1011, x: null },
  ])("uses the measured endpoint at $actual rather than forecast $destination", async (sample) => {
    await act(() => {
      renderer = create(<Workspace />, { createNodeMock: mockElement });
    });
    await act(() => renderer.update(<Workspace destination={sample.destination} moving />));
    width = sample.actual;
    await act(() => resized());
    expect(context?.detailsCard.placement).toBeNull();
    await act(() => renderer.update(<Workspace destination={sample.destination} />));
    expect(context?.detailsCard.placement).toEqual(
      sample.x === null ? null : { x: sample.x, y: 12, width: 280, height: 876 },
    );
  });

  it("keeps the card undocked when a transition reverses before workspace completion", async () => {
    await act(() => {
      renderer = create(<Workspace />, { createNodeMock: mockElement });
    });
    await act(() => renderer.update(<Workspace destination={1521} moving />));
    width = 1200;
    await act(() => resized());
    await act(() => renderer.update(<Workspace destination={900} moving />));
    expect(context?.detailsCard.placement).toBeNull();
    width = 900;
    resized = () => {
      for (const callback of resize.callbacks) callback();
    };
    await act(() => renderer.update(<Workspace destination={900} />));
    expect(context?.detailsCard.placement).toBeNull();
  });
});
