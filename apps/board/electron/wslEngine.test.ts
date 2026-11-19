import { describe, expect, it } from "vite-plus/test";

import { createLinuxHost, parseDistroList, type ProcessRunner } from "./wslEngine";

describe("wsl host", () => {
  it("Given a distro, when the app holds WSL open, then it idles one wsl.exe that lives until killed", () => {
    const started: Array<{
      command: string;
      args: ReadonlyArray<string>;
      holdStdin: boolean | undefined;
    }> = [];
    let killed = 0;
    const runner: ProcessRunner = {
      run: () => Promise.reject(new Error("unused")),
      start: (command, args, options) => {
        started.push({ command, args, holdStdin: options.holdStdin });
        return { exited: Promise.resolve(null), kill: () => void (killed += 1) };
      },
    };
    const host = createLinuxHost({ platform: "win32", distro: "board-lane", runner });

    host.hold().kill();

    expect(started).toEqual([
      {
        command: "wsl.exe",
        args: ["-d", "board-lane", "--cd", "~", "--exec", "cat"],
        holdStdin: true,
      },
    ]);
    expect(killed).toBe(1);
  });

  it("Given Linux, when the app holds WSL open, then it starts nothing", () => {
    const runner: ProcessRunner = {
      run: () => Promise.reject(new Error("unused")),
      start: () => {
        throw new Error("must not start");
      },
    };

    expect(() =>
      createLinuxHost({ platform: "linux", distro: null, runner }).hold().kill(),
    ).not.toThrow();
  });

  it("Given wsl.exe --list --verbose output, when parsed, then it names the distros and the default", () => {
    const listing =
      "  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n  board-lane  Stopped       2\r\n";

    expect(parseDistroList(listing)).toEqual([
      { name: "Ubuntu", state: "Running", version: 2, isDefault: true },
      { name: "board-lane", state: "Stopped", version: 2, isDefault: false },
    ]);
  });
});
