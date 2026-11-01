import { describe, expect, it } from "vite-plus/test";

import { agentDeviceQuickStart, pngDimensions } from "./handlers.ts";

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

  it("shows a bound launcher's commands without flags and keeps device actions off simctl and ssh", () => {
    const command = "/state/device/targets/t3-a/agent-device";
    const text = agentDeviceQuickStart(device, [], command);
    const examples = text.split("\n").filter((line) => line.trimStart().startsWith(command));
    expect(examples).toContain(`  ${command} snapshot -i  # accessibility tree with @eN refs`);
    expect(examples.find((line) => line.includes(" screenshot "))).toContain("--pixel-density <n>");
    expect(agentDeviceQuickStart({ ...device, platform: "android" }, [], command)).not.toContain(
      "--pixel-density",
    );
    expect(examples.join("\n")).not.toMatch(/--(?:platform|udid|serial|config|session)\b/);
    expect(text).not.toContain("remain available");
    expect(text).toContain("Do not use simctl, idb, adb or ssh for those actions.");
    expect(text).toContain("If it is missing, call device_open again.");
  });

  it("opens the app before snapshots, CLI screenshots or input, looks with device_screenshot, and records the device screen", () => {
    const command = "/state/device/targets/t3-a/agent-device";
    const text = agentDeviceQuickStart(device, [], command);
    // device_open starts no agent-device session, and an iOS snapshot needs one with an app.
    expect(text).toContain(
      "Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.",
    );
    // App-scoped recording needs an app opened in the session; device scope does not.
    expect(text).toContain(
      `  ${command} record start --scope device /tmp/run.mp4  # then record stop`,
    );
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
