import { describe, expect, it } from "vite-plus/test";

import { parseWslUncPath, resolveWslProjectSelection } from "./wslPaths";

describe("parseWslUncPath", () => {
  it("parses wsl.localhost UNC paths into distro and POSIX path", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo")).toEqual({
      distro: "Ubuntu-22.04",
      linuxPath: "/home/josh/repo",
    });
  });

  it("parses wsl$ UNC roots as distro root", () => {
    expect(parseWslUncPath("\\\\wsl$\\Debian")).toEqual({
      distro: "Debian",
      linuxPath: "/",
    });
  });

  it("rejects non-WSL paths and invalid distro names", () => {
    expect(parseWslUncPath("C:\\Users\\Josh\\repo")).toBeNull();
    expect(parseWslUncPath("\\\\wsl.localhost\\bad!name\\home")).toBeNull();
  });
});

describe("resolveWslProjectSelection", () => {
  it("routes a UNC path to the matching WSL backend", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\theo\\repo", [
        { environmentId: "env-debian", backendId: "wsl:Debian" },
        { environmentId: "env-ubuntu", backendId: "wsl:Ubuntu" },
      ]),
    ).toEqual({
      distro: "Ubuntu",
      environmentId: "env-ubuntu",
      linuxPath: "/home/theo/repo",
    });
  });

  it("uses the only WSL backend for a default-distro instance", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\theo\\repo", [
        { environmentId: "env-wsl", backendId: "wsl:default" },
      ]),
    ).toEqual({
      distro: "Ubuntu",
      environmentId: "env-wsl",
      linuxPath: "/home/theo/repo",
    });
  });

  it("does not guess when multiple WSL backends fail to match", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Fedora\\home\\theo\\repo", [
        { environmentId: "env-debian", backendId: "wsl:Debian" },
        { environmentId: "env-ubuntu", backendId: "wsl:Ubuntu" },
      ]),
    ).toBeNull();
  });
});
