import { describe, expect, it } from "vitest";

import { launchDetached, resolveEditorLaunch } from "./open";

describe("resolveEditorLaunch", () => {
  it("returns cursor command for cursor editor", () => {
    expect(resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "cursor" }, "darwin")).toEqual({
      command: "cursor",
      args: ["/tmp/workspace"],
    });
  });

  it("maps file-manager editor to OS open commands", () => {
    expect(
      resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "file-manager" }, "darwin"),
    ).toEqual({
      command: "open",
      args: ["/tmp/workspace"],
    });
    expect(resolveEditorLaunch({ cwd: "C:\\workspace", editor: "file-manager" }, "win32")).toEqual({
      command: "explorer",
      args: ["C:\\workspace"],
    });
    expect(resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "file-manager" }, "linux")).toEqual(
      {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      },
    );
  });
});

describe("launchDetached", () => {
  it("resolves when command can be spawned", async () => {
    await expect(launchDetached(process.execPath, ["-e", "process.exit(0)"])).resolves.toBe(
      undefined,
    );
  });

  it("rejects when command does not exist", async () => {
    await expect(launchDetached(`t3code-no-such-command-${Date.now()}`, [])).rejects.toBeInstanceOf(
      Error,
    );
  });
});
