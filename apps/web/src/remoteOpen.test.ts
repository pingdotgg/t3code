import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, EnvironmentId } from "@t3tools/contracts";
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
    // wsl-only mode binds the primary to the WSL2 NAT address; it is still
    // this machine because the desktop app manages its own primary backend.
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshTarget: null,
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
        sshTarget: null,
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
        sshTarget: { alias: "sol", username: null },
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } });
  });

  it("keeps the configured username for a desktop SSH target", () => {
    expect(
      resolveRemoteOpenState({
        target: new SshConnectionTarget({
          environmentId,
          label: "r2d2",
          connectionId: "ssh-1",
        }),
        sshTarget: { alias: "r2d2", username: "r2d2" },
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "ssh-alias", host: "r2d2", username: "r2d2" },
    });
  });

  it.each([null, "admin-user"])(
    "opens an SSH target entered as user@host once (resolved username: %s)",
    (username) => {
      const state = resolveRemoteOpenState({
        target: new SshConnectionTarget({ environmentId, label: "server", connectionId: "ssh-1" }),
        sshTarget: { alias: "admin-user@192.168.1.172", username },
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      });
      expect(state.mode).toBe("remote-links");
      if (state.mode !== "remote-links") throw new Error("Expected a remote link");
      expect(
        buildRemoteOpenUrl({ editor: "vscode", ...state.host, absolutePath: "/home/admin-user" }),
      ).toBe("vscode://vscode-remote/ssh-remote+admin-user%40192.168.1.172/home/admin-user");
      expect(
        buildRemoteOpenUrl({ editor: "zed", ...state.host, absolutePath: "/home/admin-user" }),
      ).toBe("zed://ssh/admin-user@192.168.1.172/home/admin-user");
      expect(
        buildRemoteOpenUrl({ editor: "idea", ...state.host, absolutePath: "/home/admin-user" }),
      ).toBe(
        "jetbrains://gateway/ssh/environment?h=192.168.1.172&launchIde=true&ideHint=IU&projectHint=%2Fhome%2Fadmin-user&u=admin-user",
      );
    },
  );

  it.each([
    new RelayConnectionTarget({ environmentId, label: "server" }),
    new BearerConnectionTarget({ environmentId, label: "server", connectionId: "lan-1" }),
    primaryTarget("https://server.tail1234.ts.net"),
  ])("keeps the advertised username for a network connection ($._tag)", (target) => {
    expect(
      resolveRemoteOpenState({
        target,
        sshTarget: null,
        isDesktopRenderer: false,
        remoteOpenTargets: [
          { kind: "tailscale", host: "server.tail1234.ts.net", username: "admin-user" },
        ],
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "server.tail1234.ts.net", username: "admin-user" },
    });
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

  it("falls back to exec when the environment has no catalog entry", () => {
    expect(
      resolveRemoteOpenState({
        target: null,
        sshTarget: null,
        isDesktopRenderer: false,
        remoteOpenTargets: undefined,
      }),
    ).toEqual({ mode: "local-exec" });
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

  it("includes the remote environment's login user", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "192.168.1.172",
        username: "admin-user",
        absolutePath: "/home/admin-user/project",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+admin-user%40192.168.1.172/home/admin-user/project");
    expect(
      buildRemoteOpenUrl({
        editor: "cursor",
        host: "r2d2",
        username: "r2d2",
        absolutePath: "/Users/r2d2/code",
      }),
    ).toBe("cursor://vscode-remote/ssh-remote+r2d2%40r2d2/Users/r2d2/code");
    expect(
      buildRemoteOpenUrl({
        editor: "zed",
        host: "r2d2",
        username: "r2d2",
        absolutePath: "/Users/r2d2/code",
      }),
    ).toBe("zed://ssh/r2d2@r2d2/Users/r2d2/code");
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

  it("builds a Toolbox ssh deep link for JetBrains IDEs", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "pycharm",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=sol.tail1234.ts.net&launchIde=true&ideHint=PY&projectHint=%2Fhome%2Ftheo%2Fcode%2Fmy+repo",
    );
    expect(
      buildRemoteOpenUrl({ editor: "idea", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=sol&launchIde=true&ideHint=IU&projectHint=C%3A%2FUsers%2Ftheo",
    );
  });

  it("returns undefined for editors without remote support", () => {
    expect(buildRemoteOpenUrl({ editor: "kiro", host: "sol", absolutePath: "/tmp/x" })).toBe(
      undefined,
    );
  });
});
