import { describe, expect, it, vi } from "vite-plus/test";
import { createAppIconController, type NativeAppIconState } from "./appIconController";

const initial = { icons: ["t3-code", "ocean", "iris"], selected: "t3-code" };

describe("app icon selection", () => {
  it("selects an icon and restores the primary by choosing T3 Code", async () => {
    const native = {
      getState: async () => initial,
      setIcon: vi.fn(async (selected: string) => ({ ...initial, selected })),
    };
    const controller = createAppIconController(native);
    await controller.refresh();
    await controller.select("ocean");
    expect(controller.getSnapshot().selected).toBe("ocean");
    await controller.select("t3-code");
    expect(controller.getSnapshot()).toMatchObject({
      selected: "t3-code",
      pending: false,
      error: null,
    });
    await controller.select("t3-code");
    await controller.select("missing");
    expect(native.setIcon).toHaveBeenCalledTimes(2);
  });

  it("allows one native change at a time without announcing success early", async () => {
    const change = Promise.withResolvers<NativeAppIconState>();
    const native = { getState: async () => initial, setIcon: vi.fn(() => change.promise) };
    const controller = createAppIconController(native);
    await controller.refresh();
    const selecting = controller.select("ocean");
    await controller.select("iris");
    expect(controller.getSnapshot()).toMatchObject({ pending: true, selected: "t3-code" });
    expect(native.setIcon).toHaveBeenCalledTimes(1);
    change.resolve({ ...initial, selected: "ocean" });
    await selecting;
    expect(controller.getSnapshot()).toMatchObject({ pending: false, selected: "ocean" });
  });

  it("ignores a stale native read that completes after selection", async () => {
    const read = Promise.withResolvers<NativeAppIconState>();
    const native = {
      getState: vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(read.promise),
      setIcon: async (selected: string) => ({ ...initial, selected }),
    };
    const controller = createAppIconController(native);
    await controller.refresh();
    const refreshing = controller.refresh();
    await controller.select("iris");
    read.resolve(initial);
    await refreshing;
    expect(controller.getSnapshot().selected).toBe("iris");
  });

  it("reconciles a partial native failure and permits retry", async () => {
    const native = {
      getState: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue({ ...initial, selected: "ocean" }),
      setIcon: vi
        .fn()
        .mockRejectedValueOnce(new Error("launcher failure"))
        .mockResolvedValue({ ...initial, selected: "iris" }),
    };
    const controller = createAppIconController(native);
    await controller.refresh();
    await controller.select("ocean");
    expect(controller.getSnapshot()).toMatchObject({ selected: "ocean", pending: false });
    expect(controller.getSnapshot().error).toBeTruthy();
    await controller.select("iris");
    expect(controller.getSnapshot()).toMatchObject({ selected: "iris", error: null });
  });

  it("does not claim a native operation changed the icon without readback confirmation", async () => {
    const controller = createAppIconController({
      getState: async () => initial,
      setIcon: async () => initial,
    });
    await controller.refresh();
    await controller.select("ocean");
    expect(controller.getSnapshot().selected).toBe("t3-code");
    expect(controller.getSnapshot().error).toBeTruthy();
  });

  it("remains unavailable in binaries without the native module", async () => {
    const controller = createAppIconController(null);
    await controller.refresh();
    await controller.select("ocean");
    expect(controller.getSnapshot()).toMatchObject({ icons: [], pending: false, error: null });
  });
});
