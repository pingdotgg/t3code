import { describe, expect, it } from "vitest";

import { resolveDesktopCliPassthrough } from "./desktopCliPassthrough.ts";

describe("resolveDesktopCliPassthrough", () => {
  it("runs an embedded server CLI invocation in Electron's Node mode", () => {
    const backendEntry =
      "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";

    expect(
      resolveDesktopCliPassthrough({
        argv: ["/Applications/T3 Code.app/Contents/MacOS/T3 Code", backendEntry, "project", "list"],
        backendEntry,
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        env: { PATH: "/usr/bin" },
      }),
    ).toEqual({
      command: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      args: [backendEntry, "project", "list"],
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it("ignores a normal desktop app launch", () => {
    expect(
      resolveDesktopCliPassthrough({
        argv: ["/Applications/T3 Code.app/Contents/MacOS/T3 Code"],
        backendEntry:
          "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        env: {},
      }),
    ).toBeNull();
  });

  it("recognizes the embedded CLI after Electron's development app path", () => {
    const backendEntry = "/repo/apps/server/dist/bin.mjs";

    expect(
      resolveDesktopCliPassthrough({
        argv: ["/repo/node_modules/electron", "/repo/apps/desktop", backendEntry, "--version"],
        backendEntry,
        execPath: "/repo/node_modules/electron",
        env: {},
      }),
    ).toMatchObject({
      args: [backendEntry, "--version"],
    });
  });
});
