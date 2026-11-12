import { describe, it, expect } from "vite-plus/test";

import {
  extractDistroFromUncPath,
  isValidDistroName,
  parseWslDistroList,
  resolveWslPickFolderDefaultPath,
  wslUncPathToLinuxPath,
} from "./wslPathParsing.ts";

function makeUtf16LeBuffer(text: string): Buffer {
  return Buffer.from("﻿" + text, "utf16le");
}

describe("parseWslDistroList", () => {
  it("parses standard output with default distro marked", () => {
    const output = makeUtf16LeBuffer(
      [
        "  NAME            STATE           VERSION",
        "* Ubuntu           Running         2",
        "  Debian           Stopped         2",
        "  Ubuntu-22.04     Running         1",
      ].join("\r\n"),
    );
    const distros = parseWslDistroList(output);
    expect(distros).toEqual([
      { name: "Ubuntu", isDefault: true, version: 2 },
      { name: "Debian", isDefault: false, version: 2 },
      { name: "Ubuntu-22.04", isDefault: false, version: 1 },
    ]);
  });

  it("skips malformed lines", () => {
    const output = makeUtf16LeBuffer(
      [
        "  NAME            STATE           VERSION",
        "* Ubuntu           Running         2",
        "  bad line",
        "",
        "  Debian           Stopped         2",
      ].join("\r\n"),
    );
    const distros = parseWslDistroList(output);
    expect(distros).toEqual([
      { name: "Ubuntu", isDefault: true, version: 2 },
      { name: "Debian", isDefault: false, version: 2 },
    ]);
  });

  it("handles UTF-8 output", () => {
    const text = [
      "  NAME            STATE           VERSION",
      "* Debian           Running         2",
    ].join("\r\n");
    const distros = parseWslDistroList(Buffer.from(text, "utf8"));
    expect(distros).toEqual([{ name: "Debian", isDefault: true, version: 2 }]);
  });
});

describe("extractDistroFromUncPath", () => {
  it("extracts the distro from \\\\wsl.localhost UNC paths", () => {
    expect(extractDistroFromUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh")).toBe(
      "Ubuntu-22.04",
    );
  });
});

describe("wslUncPathToLinuxPath", () => {
  it("maps WSL UNC paths back to Linux absolute paths", () => {
    expect(wslUncPathToLinuxPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo")).toBe(
      "/home/josh/repo",
    );
  });

  it("maps a distro UNC root to Linux root", () => {
    expect(wslUncPathToLinuxPath("\\\\wsl$\\Debian")).toBe("/");
    expect(wslUncPathToLinuxPath("\\\\wsl.localhost\\Debian\\")).toBe("/");
  });

  it("rejects invalid distro names and non-WSL paths", () => {
    expect(wslUncPathToLinuxPath("\\\\wsl.localhost\\bad!name\\home")).toBeNull();
    expect(wslUncPathToLinuxPath("C:\\Users\\Josh\\repo")).toBeNull();
  });
});

describe("resolveWslPickFolderDefaultPath", () => {
  const config = { distro: null };
  const distros = [{ name: "Debian", isDefault: true, version: 2 as const }];

  it("maps Linux initial paths to WSL UNC paths", () => {
    expect(
      resolveWslPickFolderDefaultPath({ initialPath: "/home/josh/project" }, config, distros),
    ).toBe("\\\\wsl.localhost\\Debian\\home\\josh\\project");
  });

  it("expands ~/path against the user's home dir when known", () => {
    expect(
      resolveWslPickFolderDefaultPath({ initialPath: "~/project" }, config, distros, "/home/josh"),
    ).toBe("\\\\wsl.localhost\\Debian\\home\\josh\\project");
  });

  it("falls back to /home parent when the user's home dir isn't known", () => {
    expect(resolveWslPickFolderDefaultPath({ initialPath: "~/project" }, config, distros)).toBe(
      "\\\\wsl.localhost\\Debian\\home\\project",
    );
  });
});

describe("isValidDistroName", () => {
  it("rejects names with trailing whitespace, hyphen, or dot", () => {
    for (const name of ["Ubuntu ", "Ubuntu-", "Ubuntu."]) {
      expect(isValidDistroName(name)).toBe(false);
    }
  });

  it("rejects names containing control or shell-meta characters", () => {
    for (const name of ["bad\nname", "bad\tname", "bad/name", "bad!name", "bad;name"]) {
      expect(isValidDistroName(name)).toBe(false);
    }
  });
});
