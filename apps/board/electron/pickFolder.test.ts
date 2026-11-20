import { describe, expect, it } from "vite-plus/test";

import { pickFolder, resolveFolder } from "./pickFolder";
import { createLinuxHost, type ProcessRunner } from "./wslEngine";

/** A Linux filesystem with these folders, answering the two scripts the resolver runs. */
function hostWithFolders(folders: ReadonlyArray<string>, windowsToLinux: Record<string, string>) {
  const scripts: string[] = [];
  const runner: ProcessRunner = {
    run: async (_command, _args, options) => {
      const script = options.stdin ?? "";
      scripts.push(script);
      const wslpath = /^wslpath -u '(.*)'$/.exec(script);
      if (wslpath?.[1] !== undefined) {
        const linux = windowsToLinux[wslpath[1]];
        return linux === undefined
          ? { exitCode: 1, stdout: "", stderr: "wslpath: not found" }
          : { exitCode: 0, stdout: `${linux}\n`, stderr: "" };
      }
      if (script.startsWith("wslpath -w")) {
        return { exitCode: 0, stdout: "\\\\wsl.localhost\\Ubuntu\\home\\kyle\r\n", stderr: "" };
      }
      const test = /^test -d '(.*)'$/.exec(script);
      const found = test?.[1] !== undefined && folders.includes(test[1]);
      return { exitCode: found ? 0 : 1, stdout: "", stderr: "" };
    },
    start: () => {
      throw new Error("unused");
    },
  };
  return { host: createLinuxHost({ platform: "win32", distro: "Ubuntu", runner }), scripts };
}

describe("resolveFolder", () => {
  it("Given a folder in WSL, when typed, then it resolves to that path", async () => {
    const { host } = hostWithFolders(["/home/kyle/app"], {});

    expect(await resolveFolder(host, " /home/kyle/app/ ")).toEqual({
      ok: true,
      path: "/home/kyle/app",
    });
  });

  it("Given a Windows drive path, when resolved, then it is refused as outside WSL", async () => {
    const { host } = hostWithFolders([], { "C:\\Users": "/mnt/c/Users" });

    expect(await resolveFolder(host, "C:\\Users")).toEqual({
      ok: false,
      reason: "That folder is outside WSL. Pick one inside the Linux distro, such as /home.",
    });
  });

  it("Given a path on a Windows drive mount, when typed, then it is refused as outside WSL", async () => {
    const { host } = hostWithFolders(["/mnt/c/Users"], {});

    const result = await resolveFolder(host, "/mnt/c/Users");

    expect(result.ok).toBe(false);
  });

  it("Given a missing folder, when typed, then the reason names it", async () => {
    const { host } = hostWithFolders([], {});

    expect(await resolveFolder(host, "/home/kyle/nope")).toEqual({
      ok: false,
      reason: "/home/kyle/nope is not a folder in WSL.",
    });
  });

  it("Given a relative path, when typed, then it asks for an absolute one", async () => {
    const { host } = hostWithFolders([], {});

    const result = await resolveFolder(host, "projects/app");

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("absolute") });
  });
});

describe("pickFolder", () => {
  it("Given a Windows picker, when the user picks a WSL share folder, then the dialog starts in the WSL home and the choice becomes a WSL path", async () => {
    const { host } = hostWithFolders(["/home/kyle/app"], {
      "\\\\wsl.localhost\\Ubuntu\\home\\kyle\\app": "/home/kyle/app",
    });
    const starts: Array<string | undefined> = [];

    const result = await pickFolder({
      host,
      platform: "win32",
      choose: async (startAt) => {
        starts.push(startAt);
        return "\\\\wsl.localhost\\Ubuntu\\home\\kyle\\app";
      },
    });

    expect(starts).toEqual(["\\\\wsl.localhost\\Ubuntu\\home\\kyle"]);
    expect(result).toEqual({ ok: true, path: "/home/kyle/app" });
  });

  it("Given the user cancels the dialog, when picking, then nothing is returned", async () => {
    const { host } = hostWithFolders([], {});

    expect(await pickFolder({ host, platform: "win32", choose: async () => null })).toBeNull();
  });
});
