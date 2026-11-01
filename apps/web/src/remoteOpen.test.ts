import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, buildWslOpenUrl, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteOpenState, wslCapableEditors } from "./remoteOpen";

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
  it("keeps exec behavior for a loopback primary target", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://127.0.0.1:8000"),
        sshTarget: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses deep links for a primary target reached over the network", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("https://sol.tail1234.ts.net"),
        sshTarget: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "sol.tail1234.ts.net" },
    });
  });

  it("keeps exec behavior for the desktop app's own primary even on a NAT URL", () => {
    // wsl-only binds the desktop-owned primary to its WSL2 NAT address.
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses the resolved distro for desktop-managed WSL environments", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets: undefined,
        wslDistro: "Ubuntu",
      }),
    ).toEqual({ mode: "wsl-links", distro: "Ubuntu" });

    expect(
      resolveRemoteOpenState({
        target: new BearerConnectionTarget({
          environmentId,
          label: "WSL (Debian)",
          connectionId: "local:wsl:default",
        }),
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets: undefined,
        wslDistro: "Debian",
      }),
    ).toEqual({ mode: "wsl-links", distro: "Debian" });
  });

  it("leaves a bare desktop SSH alias for the editor to resolve through SSH config", () => {
    const state = resolveRemoteOpenState({
      target: new SshConnectionTarget({ environmentId, label: "sol", connectionId: "ssh-1" }),
      sshTarget: { alias: "sol", username: null },
      isDesktopRenderer: true,
      remoteOpenTargets: [
        { kind: "tailscale", host: "sol.tail1234.ts.net", username: "server-user" },
      ],
    });
    expect(state).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } });
    if (state.mode !== "remote-links") throw new Error("Expected a remote link");
    expect(
      buildRemoteOpenUrl({ editor: "vscode", ...state.host, absolutePath: "/work/project" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "zed", ...state.host, absolutePath: "/work/project" }),
    ).toBe("zed://ssh/sol/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "idea", ...state.host, absolutePath: "/work/project" }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=sol&launchIde=true&ideHint=IU&projectHint=%2Fwork%2Fproject",
    );
  });

  it.each([
    { alias: "server", username: "admin-user" },
    { alias: "admin-user@server", username: null },
    { alias: "old-user@server", username: "admin-user" },
    { alias: "admin-user@server", username: "" },
    { alias: "admin-user@server", username: "  " },
  ])("keeps one login username in editor links for $alias (username: '$username')", (sshTarget) => {
    const state = resolveRemoteOpenState({
      target: new SshConnectionTarget({ environmentId, label: "server", connectionId: "ssh-1" }),
      sshTarget,
      isDesktopRenderer: true,
      remoteOpenTargets: TAILSCALE_TARGETS,
    });
    expect(state.mode).toBe("remote-links");
    if (state.mode !== "remote-links") throw new Error("Expected a remote link");
    expect(
      buildRemoteOpenUrl({ editor: "vscode", ...state.host, absolutePath: "/work/project" }),
    ).toBe("vscode://vscode-remote/ssh-remote+admin-user%40server/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "zed", ...state.host, absolutePath: "/work/project" }),
    ).toBe("zed://ssh/admin-user@server/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "idea", ...state.host, absolutePath: "/work/project" }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=server&launchIde=true&ideHint=IU&projectHint=%2Fwork%2Fproject&u=admin-user",
    );
  });

  it("uses the advertised login username in editor links over a relay", () => {
    const state = resolveRemoteOpenState({
      target: new RelayConnectionTarget({ environmentId, label: "server" }),
      sshTarget: null,
      isDesktopRenderer: false,
      remoteOpenTargets: [
        { kind: "tailscale", host: "server.tail1234.ts.net", username: "admin-user" },
      ],
    });
    expect(state.mode).toBe("remote-links");
    if (state.mode !== "remote-links") throw new Error("Expected a remote link");
    expect(
      buildRemoteOpenUrl({ editor: "cursor", ...state.host, absolutePath: "/work/project" }),
    ).toBe("cursor://vscode-remote/ssh-remote+admin-user%40server.tail1234.ts.net/work/project");
  });

  it("reports unavailable when a remote environment advertises no hosts", () => {
    for (const remoteOpenTargets of [[], undefined] as const) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "sol" }),
          sshTarget: null,
          isDesktopRenderer: false,
          remoteOpenTargets,
        }),
      ).toEqual({ mode: "remote-unavailable" });
    }
  });
});

describe("buildRemoteOpenUrl", () => {
  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({ editor: "vscode", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("drops the Windows drive letter for Zed", () => {
    expect(
      buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("zed://ssh/sol/Users/theo");
    expect(buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "/C:/project" })).toBe(
      "zed://ssh/sol/C%3A/project",
    );
  });

  it("adds a file position only for confirmed VS Code-family file targets", () => {
    const targets = [
      ["vscode", true, "vscode://vscode-remote/ssh-remote+sol/tmp/my%20file.md:1:1"],
      ["cursor", true, "cursor://vscode-remote/ssh-remote+sol/tmp/my%20file.md:1:1"],
      ["vscode", false, "vscode://vscode-remote/ssh-remote+sol/tmp/my%20file.md"],
      ["vscode", undefined, "vscode://vscode-remote/ssh-remote+sol/tmp/my%20file.md"],
      ["zed", true, "zed://ssh/sol/tmp/my%20file.md"],
      [
        "pycharm",
        true,
        "jetbrains://gateway/ssh/environment?h=sol&launchIde=true&ideHint=PY&projectHint=%2Ftmp%2Fmy+file.md",
      ],
    ] as const;

    for (const [editor, isFile, expected] of targets) {
      expect(
        buildRemoteOpenUrl({
          editor,
          host: "sol",
          absolutePath: "/tmp/my file.md",
          ...(isFile === undefined ? {} : { isFile }),
        }),
        `${editor}, isFile=${isFile}`,
      ).toBe(expected);
    }
  });
});

describe("buildWslOpenUrl", () => {
  it("uses the Linux workspace path and VS Code's WSL remote authority", () => {
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu-22.04",
        absolutePath: "/home/theo/My Project",
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu-22.04/home/theo/My%20Project");
    expect(
      buildWslOpenUrl({
        editor: "vscode-insiders",
        distro: "Ubuntu",
        absolutePath: "/home/theo/file name.md",
        isFile: true,
      }),
    ).toBe("vscode-insiders://vscode-remote/wsl+Ubuntu/home/theo/file%20name.md:1:1");
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu",
        absolutePath: "/work/file.ts",
        isFile: true,
        line: 12,
        column: 3,
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu/work/file.ts:12:3");
  });

  it("rejects unsupported editors, invalid distros, and Windows paths", () => {
    expect(
      buildWslOpenUrl({
        editor: "cursor",
        distro: "Ubuntu",
        absolutePath: "/home/theo/project",
      }),
    ).toBeUndefined();
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu/..",
        absolutePath: "/home/theo/project",
      }),
    ).toBeUndefined();
    expect(
      buildWslOpenUrl({
        editor: "vscode",
        distro: "Ubuntu",
        absolutePath: "C:\\Users\\theo\\project",
      }),
    ).toBeUndefined();
  });
});

describe("wslCapableEditors", () => {
  it("retains the VS Code fallback when the probe only finds other editors", () => {
    expect(wslCapableEditors(["cursor"])).toEqual(["vscode"]);
    expect(wslCapableEditors(["cursor", "vscode-insiders"])).toEqual(["vscode-insiders"]);
  });
});
