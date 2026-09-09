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

describe("buildRemoteOpenUrl", () => {
  it.each([
    ["/home/user/.local/share/app/settings.json", "/home/user/.local/share/app/settings.json"],
    ["/tmp/README", "/tmp/README"],
    ["/tmp/my file #1?.json", "/tmp/my%20file%20%231%3F.json"],
    ["C:\\Users\\user\\settings.json", "/C%3A/Users/user/settings.json"],
    ["/tmp/project.code-workspace", "/tmp/project.code-workspace"],
  ])("opens %s as a remote file", (absolutePath, encodedPath) => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol",
        absolutePath,
        pathKind: "file",
      }),
    ).toBe(`vscode://vscode-remote/ssh-remote+sol${encodedPath}:1`);
  });

  it("builds a vscode-remote deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
        pathKind: "folder",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it.each(["cursor", "vscode-insiders", "vscodium"] as const)("uses %s's scheme", (editor) => {
    expect(
      buildRemoteOpenUrl({ editor, host: "sol", absolutePath: "/tmp/x", pathKind: "file" }),
    ).toBe(`${editor}://vscode-remote/ssh-remote+sol/tmp/x:1`);
    expect(
      buildRemoteOpenUrl({ editor, host: "sol", absolutePath: "/tmp/x", pathKind: "folder" }),
    ).toBe(`${editor}://vscode-remote/ssh-remote+sol/tmp/x`);
  });

  it("keeps folders with file extensions as folders", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol",
        absolutePath: "/tmp/project.json",
        pathKind: "folder",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/tmp/project.json");
  });

  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol",
        absolutePath: "C:\\Users\\theo",
        pathKind: "folder",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("returns undefined for editors without remote support", () => {
    expect(
      buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "/tmp/x", pathKind: "file" }),
    ).toBe(undefined);
  });
});
