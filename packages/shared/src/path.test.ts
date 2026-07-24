import { describe, expect, it } from "vite-plus/test";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  resolveDefaultT3BaseDir,
  resolveT3XdgBaseDir,
} from "./path.ts";

const posixPath = {
  isAbsolute: (value: string) => value.startsWith("/"),
  join: (...paths: Array<string>) => paths.join("/").replaceAll(/\/+/g, "/"),
};

const windowsPath = {
  isAbsolute: isWindowsAbsolutePath,
  join: (...paths: Array<string>) => paths.join("\\"),
};

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("uses an absolute XDG data home on Unix-like platforms", () => {
    expect(
      resolveDefaultT3BaseDir({
        platform: "linux",
        homeDirectory: "/home/alice",
        xdgHome: " /mnt/data ",
        path: posixPath,
      }),
    ).toBe("/mnt/data/t3code");
    expect(
      resolveDefaultT3BaseDir({
        platform: "darwin",
        homeDirectory: "/Users/alice",
        xdgHome: "/Users/alice/.local/share",
        path: posixPath,
      }),
    ).toBe("/Users/alice/.local/share/t3code");
  });

  it("keeps the legacy home for unset, relative, and Windows XDG paths", () => {
    expect(
      resolveDefaultT3BaseDir({
        platform: "linux",
        homeDirectory: "/home/alice",
        xdgHome: "relative/data",
        path: posixPath,
      }),
    ).toBe("/home/alice/.t3");
    expect(
      resolveDefaultT3BaseDir({
        platform: "linux",
        homeDirectory: "/home/alice",
        xdgHome: " ",
        path: posixPath,
      }),
    ).toBe("/home/alice/.t3");
    expect(
      resolveDefaultT3BaseDir({
        platform: "win32",
        homeDirectory: "C:\\Users\\alice",
        xdgHome: "D:\\Data",
        path: windowsPath,
      }),
    ).toBe("C:\\Users\\alice\\.t3");
  });

  it("resolves any absolute XDG base directory to the T3 Code namespace", () => {
    expect(
      resolveT3XdgBaseDir({
        platform: "linux",
        xdgHome: "/home/alice/.config",
        path: posixPath,
      }),
    ).toBe("/home/alice/.config/t3code");
    expect(
      resolveT3XdgBaseDir({
        platform: "linux",
        xdgHome: "relative/config",
        path: posixPath,
      }),
    ).toBeUndefined();
  });
});
