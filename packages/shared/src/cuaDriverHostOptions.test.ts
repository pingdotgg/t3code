import { describe, expect, it } from "vite-plus/test";

import { cuaDriverHostOptions } from "./cuaDriverHostOptions.ts";

describe("Cua host backend selection", () => {
  it("uses Wayland even when the compositor also exposes XWayland", () => {
    const options = cuaDriverHostOptions("/driver", "t3", "linux", {
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0",
    });
    expect(options.environment).toEqual([{ name: "CUA_DRIVER_RS_ENABLE_WAYLAND", value: "1" }]);
  });

  it.each(["0", "false", ""])("preserves an explicit opt-out (%j)", (value) => {
    const environment = { WAYLAND_DISPLAY: "wayland-0", CUA_DRIVER_RS_ENABLE_WAYLAND: value };
    expect(cuaDriverHostOptions("/driver", "t3", "linux", environment).environment).toEqual([
      { name: "CUA_DRIVER_RS_ENABLE_WAYLAND", value },
    ]);
  });

  it("does not enable Wayland for X11, headless, or non-Linux hosts", () => {
    expect(cuaDriverHostOptions("/driver", "t3", "linux", { DISPLAY: ":0" }).environment).toEqual(
      [],
    );
    expect(cuaDriverHostOptions("/driver", "t3", "linux", {}).environment).toEqual([]);
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        cuaDriverHostOptions("/driver", "t3", platform, { WAYLAND_DISPLAY: "wayland-0" })
          .environment,
      ).toEqual([]);
    }
  });
});
