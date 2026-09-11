import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { createSidebarListMotion, motions } = vi.hoisted(() => {
  const motions: Array<{
    readonly parent: unknown;
    readonly update: ReturnType<typeof vi.fn>;
    readonly dispose: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    motions,
    createSidebarListMotion: vi.fn((parent: unknown) => {
      const motion = { parent, update: vi.fn(), dispose: vi.fn() };
      motions.push(motion);
      return motion;
    }),
  };
});
vi.mock("../Sidebar.motion", () => ({ createSidebarListMotion }));

import { useSidebarListMotion } from "./useSidebarListMotion";

function List({ orderKey, nodeKey = "list" }: { orderKey: string; nodeKey?: string }) {
  return <ul key={nodeKey} ref={useSidebarListMotion(orderKey)} />;
}

let renderer: ReactTestRenderer | null = null;
const nodes: object[] = [];

function render(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
      return;
    }
    renderer = create(element, {
      createNodeMock: () => {
        const node = {};
        nodes.push(node);
        return node;
      },
    });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  motions.length = 0;
  nodes.length = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("useSidebarListMotion", () => {
  it("runs one motion pass per row change and nothing while idle", () => {
    render(<List orderKey="a,b" />);
    expect(motions).toHaveLength(1);
    const motion = motions[0]!;
    expect(motion.parent).toBe(nodes[0]);
    // Mounting records the baseline without animating.
    expect(motion.update.mock.calls[0]).toEqual([false]);

    const passes = motion.update.mock.calls.length;
    render(<List orderKey="a,b" />);
    expect(motion.update).toHaveBeenCalledTimes(passes);

    render(<List orderKey="b,a" />);
    expect(motion.update).toHaveBeenCalledTimes(passes + 1);
    expect(motion.update).toHaveBeenLastCalledWith(true);

    // Emptying the list resets the baseline instead of fading rows out.
    render(<List orderKey="" />);
    expect(motion.update).toHaveBeenLastCalledWith(false);
    expect(motion.dispose).not.toHaveBeenCalled();
  });

  it("disposes the motion as soon as its list detaches", () => {
    render(<List orderKey="a" />);
    render(<List orderKey="a" nodeKey="replacement" />);
    expect(motions).toHaveLength(2);
    expect(motions[0]!.dispose).toHaveBeenCalledOnce();
    expect(motions[1]!.parent).toBe(nodes[1]);
    expect(motions[1]!.dispose).not.toHaveBeenCalled();

    act(() => renderer!.unmount());
    renderer = null;
    expect(motions[1]!.dispose).toHaveBeenCalledOnce();
    expect(motions).toHaveLength(2);
  });
});
