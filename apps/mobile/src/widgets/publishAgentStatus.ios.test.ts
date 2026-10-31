import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  layoutLoaded: false,
  widget: { reload: vi.fn(), updateTimeline: vi.fn() },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => ({}) }));
vi.mock("./AgentStatus", () => {
  native.layoutLoaded = true;
  return { default: native.widget };
});

describe("publishAgentStatus on iOS", () => {
  it("registers and reloads the widget at launch, before any environment connects", async () => {
    await import("./publishAgentStatus.ios");

    await vi.waitFor(() => expect(native.widget.reload).toHaveBeenCalledTimes(1));
    expect(native.layoutLoaded).toBe(true);
    expect(native.widget.updateTimeline).not.toHaveBeenCalled();
  });

  it("logs a widget that fails to load once, then publishes nothing", async () => {
    vi.resetModules();
    native.widget.reload.mockImplementationOnce(() => {
      throw new Error("widget layout missing");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { publishAgentStatus } = await import("./publishAgentStatus.ios");
    const { buildAgentStatusSnapshot } = await import("./agentStatusSnapshot");
    const snapshot = buildAgentStatusSnapshot([], { now: 0 });

    await expect(publishAgentStatus(snapshot)).resolves.toBeUndefined();
    await expect(publishAgentStatus(snapshot)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(native.widget.updateTimeline).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
