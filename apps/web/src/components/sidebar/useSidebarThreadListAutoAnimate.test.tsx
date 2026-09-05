import type { AnimationController } from "@formkit/auto-animate";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { autoAnimate } = vi.hoisted(() => ({ autoAnimate: vi.fn() }));
vi.mock("@formkit/auto-animate", () => ({ autoAnimate }));

import { useSidebarThreadListAutoAnimate } from "./useSidebarThreadListAutoAnimate";

let renderer: ReactTestRenderer | null;
let controllers: AnimationController[];

function ThreadList({ rowCount, nodeKey = "list" }: { rowCount: number; nodeKey?: string }) {
  const attach = useSidebarThreadListAutoAnimate(rowCount);
  return <ul key={nodeKey} ref={attach} />;
}

function mount(rowCount: number) {
  act(() => {
    renderer = create(<ThreadList rowCount={rowCount} />, {
      createNodeMock: () => ({}) as HTMLElement,
    });
  });
}

function update(rowCount: number, nodeKey = "list") {
  act(() => renderer!.update(<ThreadList rowCount={rowCount} nodeKey={nodeKey} />));
}

beforeEach(() => {
  renderer = null;
  controllers = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  autoAnimate.mockReset();
  autoAnimate.mockImplementation((parent: HTMLElement): AnimationController => {
    let enabled = true;
    const controller = {
      parent,
      enable: vi.fn(() => {
        enabled = true;
      }),
      disable: () => {
        enabled = false;
      },
      isEnabled: () => enabled,
      destroy: vi.fn(() => {
        enabled = false;
      }),
    };
    controllers.push(controller);
    return controller;
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("legacy sidebar thread-list animation", () => {
  it.each([
    [0, 1],
    [1, 1],
    [20, 1],
    [21, 0],
    [101, 0],
  ])("registers %i visible thread rows with %i observers", (rowCount, count) => {
    mount(rowCount);
    expect(controllers).toHaveLength(count);
    if (count) expect(controllers[0]!.isEnabled()).toBe(true);
  });

  it("keeps one controller and ordinary animation for small changes", () => {
    mount(19);
    const controller = controllers[0]!;
    update(20);
    update(19);
    expect(controllers).toHaveLength(1);
    expect(controller.isEnabled()).toBe(true);
    expect(controller.destroy).not.toHaveBeenCalled();
  });

  it.each([0, 1, 20])(
    "unregisters large lists and recreates animation after collapsing to %i rows",
    (rowCount) => {
      mount(20);
      const controller = controllers[0]!;
      update(101);
      expect(controller.destroy).toHaveBeenCalledOnce();
      expect(controller.isEnabled()).toBe(false);

      update(rowCount);
      expect(controller.isEnabled()).toBe(false);
      expect(controllers).toHaveLength(2);
      expect(controllers[1]!.isEnabled()).toBe(true);

      update(rowCount === 20 ? 19 : rowCount + 1);
      expect(controllers).toHaveLength(2);
      expect(controllers[1]!.isEnabled()).toBe(true);
    },
  );

  it("does not leave an observer after a rapid collapse and expansion", () => {
    mount(101);
    expect(controllers).toHaveLength(0);
    update(1);
    const controller = controllers[0]!;
    update(101);
    expect(controller.destroy).toHaveBeenCalledOnce();
    expect(controller.isEnabled()).toBe(false);
  });

  it("reuses the recreated observer for consecutive small commits", () => {
    mount(101);
    update(1);
    const controller = controllers[0]!;
    update(2);
    expect(controllers).toHaveLength(1);
    expect(controller.isEnabled()).toBe(true);
  });

  it("destroys the small-list controller on unmount", () => {
    mount(1);
    const controller = controllers[0]!;
    act(() => renderer!.unmount());
    renderer = null;
    expect(controller.destroy).toHaveBeenCalledOnce();
    expect(controller.isEnabled()).toBe(false);
  });

  it.each([1, 101])("recreates controller state after replacing a %i-row node", (rowCount) => {
    mount(1);
    const oldController = controllers[0]!;
    update(rowCount, "replacement");
    expect(oldController.destroy).toHaveBeenCalledOnce();
    expect(oldController.isEnabled()).toBe(false);
    expect(controllers).toHaveLength(rowCount === 1 ? 2 : 1);
    if (rowCount === 1) expect(controllers[1]!.isEnabled()).toBe(true);
  });

  it("recreates and cleans up the controller during StrictMode replay", () => {
    act(() => {
      renderer = create(
        <StrictMode>
          <ThreadList rowCount={1} />
        </StrictMode>,
        { createNodeMock: () => ({}) as HTMLElement },
      );
    });
    expect(controllers).toHaveLength(2);
    expect(controllers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controllers[1]!.isEnabled()).toBe(true);
  });
});
