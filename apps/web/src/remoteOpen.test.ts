import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, buildWslOpenUrl, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteOpenState } from "./remoteOpen";

const environmentId = EnvironmentId.make("environment-1");

const primaryTarget = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({
    environmentId,
    label: "sol",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace("http", "ws"),
  });

const TAILSCALE_TARGETS = [
  { kind: "tailscale", host: "sol.tail1234.ts.net" },
  { kind: "mdns", host: "sol.local" },
] as const;

describe("resolveRemoteOpenState", () => {
  it("opens a configured local WSL even without an SSH route", () => {
    expect(
      resolveRemoteOpenState({
        target: new RelayConnectionTarget({ environmentId, label: "Uliverse" }),
        sshAlias: null,
        remoteOpenTargets: [],
        isDesktopRenderer: false,
        isWindowsClient: true,
        localWslDistro: "Ubuntu",
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "wsl", host: "Ubuntu" } });
  });

  it("uses an explicit WSL choice ahead of local execution and advertised SSH", () => {
    for (const isDesktopRenderer of [false, true]) {
      expect(
        resolveRemoteOpenState({
          target: primaryTarget("http://localhost:8000"),
          sshAlias: "sol",
          remoteOpenTargets: TAILSCALE_TARGETS,
          isDesktopRenderer,
          isWindowsClient: true,
          localWslDistro: "Ubuntu",
        }),
      ).toEqual({ mode: "remote-links", host: { kind: "wsl", host: "Ubuntu" } });
    }
  });

  it("restores automatic behavior when WSL is cleared or the viewer is not Windows", () => {
    for (const override of [
      { isWindowsClient: true, localWslDistro: null },
      { isWindowsClient: false, localWslDistro: "Ubuntu" },
      { isWindowsClient: true, localWslDistro: "../Ubuntu" },
    ]) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "Uliverse" }),
          sshAlias: null,
          remoteOpenTargets: [],
          isDesktopRenderer: false,
          ...override,
        }),
      ).toEqual({ mode: "remote-unavailable" });
    }
  });
  it("keeps exec behavior for a loopback primary target", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://127.0.0.1:8000"),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses deep links for a primary target reached over the network", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("https://sol.tail1234.ts.net"),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "sol.tail1234.ts.net" },
    });
  });

  it("keeps exec behavior for the desktop app's own primary even on a NAT URL", () => {
    // wsl-only mode binds the primary to the WSL2 NAT address; it is still
    // this machine because the desktop app manages its own primary backend.
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshAlias: null,
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("keeps exec behavior for desktop-local secondary backends", () => {
    expect(
      resolveRemoteOpenState({
        target: new BearerConnectionTarget({
          environmentId,
          label: "WSL (Ubuntu)",
          connectionId: "local:wsl-1",
        }),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("prefers the desktop SSH alias over server-advertised hosts", () => {
    expect(
      resolveRemoteOpenState({
        target: new SshConnectionTarget({
          environmentId,
          label: "sol",
          connectionId: "ssh-1",
        }),
        sshAlias: "sol",
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } });
  });

  it("reports unavailable when a remote environment advertises no hosts", () => {
    for (const remoteOpenTargets of [[], undefined] as const) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "sol" }),
          sshAlias: null,
          isDesktopRenderer: false,
          remoteOpenTargets,
        }),
      ).toEqual({ mode: "remote-unavailable" });
    }
  });

  it("falls back to exec when the environment has no catalog entry", () => {
    expect(
      resolveRemoteOpenState({
        target: null,
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: undefined,
      }),
    ).toEqual({ mode: "local-exec" });
  });
});

describe("buildWslOpenUrl", () => {
  it("distinguishes a file from a folder and preserves explicit line positions", () => {
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu",
        absolutePath: "/repo/file",
        isFile: true,
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu/repo/file%3A1");
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu",
        absolutePath: "/repo/file:12:3",
        isFile: true,
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu/repo/file%3A12%3A3");
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu",
        absolutePath: "/repo/folder.with.dots",
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu/repo/folder.with.dots");
  });
  it("opens a POSIX file in a named distro with reserved characters encoded", () => {
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu Dev",
        absolutePath: "/home/ulima/my repo/a#b?c%.ts:12:3",
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu%20Dev/home/ulima/my%20repo/a%23b%3Fc%25.ts%3A12%3A3");
  });

  it("supports VS Code Insiders and distro roots", () => {
    expect(
      buildWslOpenUrl({ editor: "vscode-insiders", distro: "Ubuntu-24.04", absolutePath: "/" }),
    ).toBe("vscode-insiders://vscode-remote/wsl+Ubuntu-24.04/");
  });

  it("does not offer unverified editor forks or malformed WSL targets", () => {
    expect(
      buildWslOpenUrl({ editor: "cursor", distro: "Ubuntu", absolutePath: "/tmp/x" }),
    ).toBeUndefined();
    for (const distro of [
      "",
      "../Ubuntu",
      "Ubuntu/Other",
      "Ubuntu+Other",
      "Ubuntu%2Fother",
      "Ubuntu\nOther",
    ]) {
      expect(buildWslOpenUrl({ editor: "vscode", distro, absolutePath: "/tmp/x" })).toBeUndefined();
    }
    for (const absolutePath of ["relative/file", "C:\\repo", ""]) {
      expect(buildWslOpenUrl({ editor: "vscode", distro: "Ubuntu", absolutePath })).toBeUndefined();
    }
  });
});

describe("buildRemoteOpenUrl", () => {
  it("builds a vscode-remote deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it("uses the fork's scheme", () => {
    expect(buildRemoteOpenUrl({ editor: "cursor", host: "sol", absolutePath: "/tmp/x" })).toBe(
      "cursor://vscode-remote/ssh-remote+sol/tmp/x",
    );
  });

  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({ editor: "vscode", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("builds Zed's ssh deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "zed",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe("zed://ssh/sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it("drops the Windows drive letter for Zed", () => {
    expect(
      buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("zed://ssh/sol/Users/theo");
    expect(buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "/C:/project" })).toBe(
      "zed://ssh/sol/C%3A/project",
    );
  });

  it("returns undefined for editors without remote support", () => {
    expect(buildRemoteOpenUrl({ editor: "idea", host: "sol", absolutePath: "/tmp/x" })).toBe(
      undefined,
    );
  });
});
