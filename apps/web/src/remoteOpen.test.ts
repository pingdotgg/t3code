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
        sshAlias: null,
        connection: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses deep links to the host a browser reached its primary target at", () => {
    const target = primaryTarget("http://sol:3773");
    expect(
      resolveRemoteOpenState({
        target,
        sshAlias: null,
        connection: { target, httpBaseUrl: target.httpBaseUrl },
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "connection", host: "sol" } });
  });

  it("uses the host of the route the client is connected over, ahead of advertised hosts", () => {
    const cases = [
      ["http://nixos:3773/", "nixos"],
      ["https://nixos.tail9876.ts.net/", "nixos.tail9876.ts.net"],
      ["http://100.101.102.103:3773/", "100.101.102.103"],
      ["http://[fd7a:115c:a1e0::5]:3773/", "fd7a:115c:a1e0::5"],
    ] as const;
    for (const [httpBaseUrl, host] of cases) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "sol" }),
          sshAlias: null,
          connection: {
            target: new BearerConnectionTarget({ environmentId, label: "sol", connectionId: "c1" }),
            httpBaseUrl,
          },
          isDesktopRenderer: true,
          remoteOpenTargets: TAILSCALE_TARGETS,
        }),
      ).toEqual({ mode: "remote-links", host: { kind: "connection", host } });
    }
  });

  it("falls back to advertised hosts when the connection has no host to reuse", () => {
    const connections = [
      {
        target: new RelayConnectionTarget({ environmentId, label: "sol" }),
        httpBaseUrl: "https://prod-1234.relay.example.test/",
      },
      {
        target: new BearerConnectionTarget({ environmentId, label: "sol", connectionId: "c1" }),
        httpBaseUrl: "http://127.0.0.1:3773/",
      },
      {
        target: new BearerConnectionTarget({ environmentId, label: "sol", connectionId: "c1" }),
        httpBaseUrl: "http://[::1]:3773/",
      },
      {
        target: new BearerConnectionTarget({ environmentId, label: "sol", connectionId: "c1" }),
        httpBaseUrl: "http://127.0.0.2:3773/",
      },
      null,
    ];
    for (const connection of connections) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "sol" }),
          sshAlias: null,
          connection,
          isDesktopRenderer: true,
          remoteOpenTargets: TAILSCALE_TARGETS,
        }),
      ).toEqual({
        mode: "remote-links",
        host: { kind: "tailscale", host: "sol.tail1234.ts.net" },
      });
    }
  });

  it("stays unavailable when the server reports no sshd, whatever host the client used", () => {
    const connection = {
      target: new BearerConnectionTarget({ environmentId, label: "sol", connectionId: "c1" }),
      httpBaseUrl: "http://nixos:3773/",
    };
    expect(
      resolveRemoteOpenState({
        target: connection.target,
        sshAlias: null,
        connection,
        isDesktopRenderer: true,
        remoteOpenTargets: [],
      }),
    ).toEqual({ mode: "remote-unavailable" });
    expect(
      resolveRemoteOpenState({
        target: connection.target,
        sshAlias: null,
        connection,
        isDesktopRenderer: true,
        remoteOpenTargets: undefined,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "connection", host: "nixos" } });
  });

  it("keeps the SSH alias ahead of the connection host", () => {
    expect(
      resolveRemoteOpenState({
        target: new SshConnectionTarget({ environmentId, label: "sol", connectionId: "ssh-1" }),
        sshAlias: "sol-ssh",
        connection: {
          target: new BearerConnectionTarget({ environmentId, label: "sol", connectionId: "c1" }),
          httpBaseUrl: "http://192.168.1.10:3773/",
        },
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol-ssh" } });
  });

  it("keeps exec behavior for the desktop app's own primary even on a NAT URL", () => {
    // wsl-only mode binds the primary to the WSL2 NAT address; it is still
    // this machine because the desktop app manages its own primary backend.
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshAlias: null,
        connection: null,
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
        connection: null,
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
        connection: {
          target: new SshConnectionTarget({ environmentId, label: "sol", connectionId: "ssh-1" }),
          httpBaseUrl: "http://127.0.0.1:52011",
        },
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
          connection: null,
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
        connection: null,
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

  it("passes IPv6 hosts bare to Remote-SSH and Toolbox and bracketed to Zed", () => {
    for (const host of ["fd7a:115c::5", "[fd7a:115c::5]"]) {
      expect(buildRemoteOpenUrl({ editor: "vscode", host, absolutePath: "/tmp/x" })).toBe(
        "vscode://vscode-remote/ssh-remote+fd7a%3A115c%3A%3A5/tmp/x",
      );
      expect(buildRemoteOpenUrl({ editor: "zed", host, absolutePath: "/tmp/x" })).toBe(
        "zed://ssh/[fd7a:115c::5]/tmp/x",
      );
      expect(buildRemoteOpenUrl({ editor: "idea", host, absolutePath: "/tmp/x" })).toBe(
        "jetbrains://gateway/ssh/environment?h=fd7a%3A115c%3A%3A5&launchIde=true&ideHint=IU&projectHint=%2Ftmp%2Fx",
      );
    }
  });

  it("returns undefined for editors without remote support", () => {
    expect(buildRemoteOpenUrl({ editor: "kiro", host: "sol", absolutePath: "/tmp/x" })).toBe(
      undefined,
    );
  });
});
