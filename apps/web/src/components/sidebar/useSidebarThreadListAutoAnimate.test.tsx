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
  return controllers[0]!;
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
    [0, true],
    [1, true],
    [20, true],
    [21, false],
    [101, false],
  ])("sets animation for %i visible thread rows to %s", (rowCount, enabled) => {
    expect(mount(rowCount).isEnabled()).toBe(enabled);
  });

  it("keeps one controller and ordinary animation for small changes", () => {
    const controller = mount(19);
    update(20);
    update(19);
    expect(controllers).toHaveLength(1);
    expect(controller.isEnabled()).toBe(true);
    expect(controller.destroy).not.toHaveBeenCalled();
  });

  it.each([0, 1, 20])(
    "bypasses bulk collapse to %i rows before restoring small-list animation",
    async (rowCount) => {
      const controller = mount(20);
      update(101);
      expect(controller.isEnabled()).toBe(false);

      update(rowCount);
      expect(controller.isEnabled()).toBe(false);
      await Promise.resolve();
      expect(controller.isEnabled()).toBe(true);

      update(rowCount === 20 ? 19 : rowCount + 1);
      expect(controller.isEnabled()).toBe(true);
    },
  );

  it("does not re-enable a large list after a newer render", async () => {
    const controller = mount(101);
    update(1);
    update(101);
    await Promise.resolve();
    expect(controller.isEnabled()).toBe(false);
  });

  it("keeps a second small commit disabled until the bulk removal is processed", async () => {
    const controller = mount(101);
    update(1);
    update(2);
    expect(controller.isEnabled()).toBe(false);
    await Promise.resolve();
    expect(controller.isEnabled()).toBe(true);
  });

  it("destroys the controller on unmount and cancels its pending re-enable", async () => {
    const controller = mount(101);
    update(1);
    act(() => renderer!.unmount());
    renderer = null;
    await Promise.resolve();
    expect(controller.destroy).toHaveBeenCalledOnce();
    expect(controller.isEnabled()).toBe(false);
  });

  it.each([1, 101])(
    "recreates controller state after replacing a %i-row node",
    async (rowCount) => {
      const oldController = mount(101);
      update(rowCount);
      update(101, "replacement");
      await Promise.resolve();
      expect(oldController.destroy).toHaveBeenCalledOnce();
      expect(oldController.isEnabled()).toBe(false);
      expect(controllers).toHaveLength(2);
      expect(controllers[1]!.isEnabled()).toBe(false);
    },
  );

  it("recreates and cleans up the controller during StrictMode replay", () => {
    act(() => {
      renderer = create(
        <StrictMode>
          <ThreadList rowCount={101} />
        </StrictMode>,
        { createNodeMock: () => ({}) as HTMLElement },
      );
    });
    expect(controllers).toHaveLength(2);
    expect(controllers[0]!.destroy).toHaveBeenCalledOnce();
    expect(controllers[1]!.isEnabled()).toBe(false);
  });
});
