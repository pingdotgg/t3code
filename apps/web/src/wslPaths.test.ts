import { describe, expect, it } from "vite-plus/test";

import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "./wslPaths";

describe("parseWslUncPath", () => {
  it("parses wsl.localhost UNC paths into distro and POSIX path", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo")).toEqual({
      distro: "Ubuntu-22.04",
      linuxPath: "/home/josh/repo",
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
        { environmentId: "env-debian", backendId: "wsl:Debian", runningDistro: null },
        { environmentId: "env-ubuntu", backendId: "wsl:Ubuntu", runningDistro: null },
      ]),
    ).toEqual({
      distro: "Ubuntu",
      environmentId: "env-ubuntu",
      linuxPath: "/home/theo/repo",
    });
  });

  it("does not route to a sole WSL backend for a different distro", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Debian\\home\\theo\\repo", [
        { environmentId: "env-ubuntu", backendId: "wsl:Ubuntu", runningDistro: null },
      ]),
    ).toBeNull();
  });

  it("routes a default backend only to the distro used by its running process", () => {
    const candidates = [
      { environmentId: "env-wsl", backendId: "wsl:default", runningDistro: "Debian" },
    ];

    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Debian\\home\\theo\\repo", candidates),
    ).toEqual({
      distro: "Debian",
      environmentId: "env-wsl",
      linuxPath: "/home/theo/repo",
    });
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\theo\\repo", candidates),
    ).toBeNull();
  });
});

describe("applyWslEnvironmentConfiguration", () => {
  const ubuntuConfiguration = {
    enabled: true,
    wslOnly: false,
    distro: null,
    distros: [
      { name: "Debian", isDefault: false },
      { name: "Ubuntu", isDefault: true },
    ],
  };

  it("does not replace a live default backend's running distro from current configuration", () => {
    const candidates = applyWslEnvironmentConfiguration(
      [{ environmentId: "env-wsl", backendId: "wsl:default", runningDistro: "Debian" }],
      "env-primary",
      ubuntuConfiguration,
    );

    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\theo\\repo", candidates),
    ).toBeNull();
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Debian\\home\\theo\\repo", candidates),
    ).toEqual({
      distro: "Debian",
      environmentId: "env-wsl",
      linuxPath: "/home/theo/repo",
    });
  });

  it("represents an explicitly configured WSL-only primary by its distro", () => {
    expect(
      applyWslEnvironmentConfiguration([], "env-primary", {
        ...ubuntuConfiguration,
        wslOnly: true,
        distro: "ubuntu",
      }),
    ).toEqual([{ environmentId: "env-primary", backendId: "wsl:Ubuntu", runningDistro: "Ubuntu" }]);
  });

  it("uses the live primary distro for a default-tracking WSL-only primary", () => {
    const candidates = applyWslEnvironmentConfiguration(
      [],
      "env-primary",
      {
        ...ubuntuConfiguration,
        wslOnly: true,
        distros: [],
      },
      "Ubuntu",
    );

    expect(candidates).toEqual([
      { environmentId: "env-primary", backendId: "wsl:default", runningDistro: "Ubuntu" },
    ]);
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\theo\\repo", candidates),
    ).toEqual({
      distro: "Ubuntu",
      environmentId: "env-primary",
      linuxPath: "/home/theo/repo",
    });
  });
});

describe("resolveProjectPickerTarget", () => {
  const ubuntuConfiguration = {
    enabled: true,
    wslOnly: true,
    distro: "Ubuntu-22.04",
    distros: [
      { name: "Debian", isDefault: true },
      { name: "Ubuntu-22.04", isDefault: false },
    ],
  };

  it("routes a WSL-only primary picker to its configured distro", () => {
    expect(
      resolveProjectPickerTarget({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        desktopInstanceId: null,
        wslConfiguration: ubuntuConfiguration,
      }),
    ).toBe("wsl:Ubuntu-22.04");
  });

  it("uses installed casing when discovery finds the configured distro", () => {
    expect(
      resolveProjectPickerTarget({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        desktopInstanceId: null,
        wslConfiguration: { ...ubuntuConfiguration, distro: "ubuntu-22.04" },
      }),
    ).toBe("wsl:Ubuntu-22.04");
  });

  it("routes a default-tracking WSL-only primary picker through the live sentinel", () => {
    expect(
      resolveProjectPickerTarget({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        desktopInstanceId: null,
        wslConfiguration: { ...ubuntuConfiguration, distro: null },
      }),
    ).toBe("wsl:default");
  });

  it("preserves combo-mode routing for primary and WSL backends", () => {
    const comboConfiguration = { ...ubuntuConfiguration, wslOnly: false };

    expect(
      resolveProjectPickerTarget({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        desktopInstanceId: null,
        wslConfiguration: comboConfiguration,
      }),
    ).toBeNull();
    expect(
      resolveProjectPickerTarget({
        browseEnvironmentId: "env-wsl",
        primaryEnvironmentId: "env-primary",
        desktopInstanceId: "wsl:Ubuntu-22.04",
        wslConfiguration: comboConfiguration,
      }),
    ).toBe("wsl:Ubuntu-22.04");
  });
});
