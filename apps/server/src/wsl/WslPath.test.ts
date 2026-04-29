import { describe, expect, it } from "vitest";
import {
  isUnsupportedNetworkPath,
  parseWslUncPath,
  resolvePosixChild,
  windowsPathToMntPath,
} from "./WslPath.ts";

describe("WslPath", () => {
  it("parses wsl.localhost UNC paths", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\project")).toEqual({
      distroName: "Ubuntu",
      path: "/home/me/project",
    });
  });

  it("parses legacy wsl$ UNC paths", () => {
    expect(parseWslUncPath("\\\\wsl$\\Debian\\tmp")).toEqual({
      distroName: "Debian",
      path: "/tmp",
    });
  });

  it("maps Windows drive paths to /mnt drive paths", () => {
    expect(windowsPathToMntPath("C:\\Users\\me\\project")).toBe("/mnt/c/Users/me/project");
  });

  it("rejects unsupported network shares", () => {
    expect(isUnsupportedNetworkPath("\\\\server\\share\\project")).toBe(true);
  });

  it("rejects POSIX child paths outside the root", () => {
    expect(resolvePosixChild("/home/me/project", "../other")).toBe(null);
    expect(resolvePosixChild("/home/me/project", "src/index.ts")).toBe(
      "/home/me/project/src/index.ts",
    );
  });
});
