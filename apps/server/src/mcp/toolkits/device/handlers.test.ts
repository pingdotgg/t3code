import { describe, expect, it } from "vite-plus/test";

import { agentDeviceQuickStart, agentDeviceTargetArgs, pngDimensions } from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

describe("device tool helpers", () => {
  it("pins agent-device commands to the device by platform-specific flag", () => {
    expect(agentDeviceTargetArgs(device)).toEqual(["--platform", "ios", "--udid", "ABCD-1234"]);
    expect(agentDeviceTargetArgs({ ...device, platform: "android", id: "emulator-5554" })).toEqual([
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
    ]);
  });

  it("writes the quick start around the pinned target", () => {
    const text = agentDeviceQuickStart(device);
    expect(text).toContain("agent-device snapshot -i --platform ios --udid ABCD-1234");
    expect(text).toContain("iPhone 17 Pro (iOS 27.0)");
    expect(text).toContain("XCTest runner");
  });

  it("uses the absolute launcher in every quick-start command", () => {
    const text = agentDeviceQuickStart(
      device,
      ["--session", "thread-1", "--config", "/tmp/host.json"],
      "/tmp/t3 tools/agent-device",
    );
    expect(text).toContain(
      "'/tmp/t3 tools/agent-device' snapshot -i --session thread-1 --config /tmp/host.json",
    );
    expect(text).not.toContain("  agent-device ");
    expect(text).not.toContain("is on PATH");
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});
