import { describe, expect, it } from "@effect/vitest";

import { desktopLayoutFromKscreen, kdeSessionProblem } from "./KdeDesktop.ts";

const plasma = {
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_CURRENT_DESKTOP: "KDE",
};

describe("kdeSessionProblem", () => {
  it.each([
    ["a Plasma Wayland session", "linux", plasma, null],
    [
      "a Plasma session that lists several desktops",
      "linux",
      { ...plasma, XDG_CURRENT_DESKTOP: "ubuntu:KDE" },
      null,
    ],
    ["macOS", "darwin", plasma, "not Linux"],
    [
      "SSH with no session bus",
      "linux",
      { ...plasma, DBUS_SESSION_BUS_ADDRESS: "" },
      "started over SSH",
    ],
    ["Plasma on X11", "linux", { ...plasma, WAYLAND_DISPLAY: undefined }, "started over SSH"],
    ["GNOME", "linux", { ...plasma, XDG_CURRENT_DESKTOP: "GNOME" }, "not KDE Plasma"],
  ] as const)("reports %s", (_, platform, env, problem) => {
    const result = kdeSessionProblem(platform, env);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });
});

const output = (x: number, y: number, width: number, height: number, extra = {}) => ({
  name: "DP-1",
  enabled: true,
  pos: { x, y },
  size: { width, height },
  scale: 1,
  rotation: 1,
  ...extra,
});

describe("desktopLayoutFromKscreen", () => {
  it.each([
    [
      "two side-by-side screens",
      [output(0, 0, 2560, 1440), output(2560, 0, 2560, 1440)],
      {
        bounds: { x: 0, y: 0, width: 5120, height: 1440 },
        scale: 1,
        screens: [
          { x: 0, y: 0, width: 2560, height: 1440 },
          { x: 2560, y: 0, width: 2560, height: 1440 },
        ],
      },
    ],
    // A 4K panel at 2x is 1920x1080 logical; turned right it stands 1080 wide.
    [
      "a scaled, rotated screen",
      [output(0, 0, 2560, 1440), output(2560, 0, 3840, 2160, { scale: 2, rotation: 8 })],
      {
        bounds: { x: 0, y: 0, width: 3640, height: 1920 },
        scale: 2,
        screens: [
          { x: 0, y: 0, width: 2560, height: 1440 },
          { x: 2560, y: 0, width: 1080, height: 1920 },
        ],
      },
    ],
    [
      "a disabled screen",
      [output(0, 0, 1920, 1080), output(1920, 0, 1920, 1080, { enabled: false, scale: 2 })],
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scale: 1,
        screens: [{ x: 0, y: 0, width: 1920, height: 1080 }],
      },
    ],
    ["no enabled screens", [output(0, 0, 1920, 1080, { enabled: false })], null],
  ] as const)("measures %s", (_, outputs, layout) => {
    expect(desktopLayoutFromKscreen(JSON.stringify({ outputs, screen: {} }))).toEqual(layout);
  });

  it("rejects output it cannot read", () => {
    expect(desktopLayoutFromKscreen("kscreen-doctor: no backend")).toBeNull();
  });
});
