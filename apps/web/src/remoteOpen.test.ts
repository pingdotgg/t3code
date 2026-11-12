import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { remoteFallbackEditors, resolveRemoteOpenState } from "./remoteOpen";

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
        hostEnvironmentId: null,
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
        hostEnvironmentId: null,
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
        hostEnvironmentId: null,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("keeps exec behavior for the environment that owns the desktop's T3 home", () => {
    // With Local environment off, a background service on this machine can own the
    // desktop's home and still be reached through T3 Connect.
    expect(
      resolveRemoteOpenState({
        target: new RelayConnectionTarget({ environmentId, label: "sol" }),
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
        hostEnvironmentId: environmentId,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses deep links for other environments when the desktop home has its own", () => {
    expect(
      resolveRemoteOpenState({
        target: new RelayConnectionTarget({ environmentId, label: "sol" }),
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
        hostEnvironmentId: EnvironmentId.make("environment-host"),
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "sol.tail1234.ts.net" },
    });
  });

  it("leaves a bare desktop SSH alias for the editor to resolve through SSH config", () => {
    const state = resolveRemoteOpenState({
      target: new SshConnectionTarget({ environmentId, label: "sol", connectionId: "ssh-1" }),
      sshTarget: { alias: "sol", username: null },
      isDesktopRenderer: true,
      remoteOpenTargets: [
        { kind: "tailscale", host: "sol.tail1234.ts.net", username: "server-user" },
      ],
      hostEnvironmentId: null,
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
      hostEnvironmentId: null,
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
      hostEnvironmentId: null,
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
          hostEnvironmentId: null,
        }),
      ).toEqual({ mode: "remote-unavailable" });
    }
  });
});

describe("remoteFallbackEditors", () => {
  it.each([
    {
      // iPadOS Safari requests the desktop site with a Macintosh user agent by default.
      device: "iPad with a desktop user agent",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
    {
      device: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
    {
      device: "Android phone",
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv81",
      maxTouchPoints: 5,
    },
  ])("offers no desktop editor for remote links on an $device", ({ device: _, ...identity }) => {
    expect(remoteFallbackEditors(identity)).toEqual([]);
  });

  it("keeps the VS Code fallback for remote links on a Mac", () => {
    expect(
      remoteFallbackEditors({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toEqual(["vscode"]);
  });
});

describe("buildRemoteOpenUrl", () => {
  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({ editor: "vscode", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("keeps a plus in the SSH username through Remote-SSH's authority parsing", () => {
    const url = buildRemoteOpenUrl({
      editor: "vscode",
      host: "ssh.example.com",
      username: "vm+demo",
      absolutePath: "/workspace/project",
    });
    // VS Code decodes the authority, then Remote-SSH (0.129) takes `authority.split("+")[1]` and
    // reads it as hex-encoded JSON `{ hostName, user }` or as `user@host`.
    const authority = decodeURIComponent(new URL(url ?? "").pathname.split("/")[1] ?? "");
    const destination = authority.split("+")[1] ?? "";
    const hexBytes = /^(?:[0-9a-f]{2})+$/i.test(destination)
      ? destination.match(/../g)?.map((byte) => Number.parseInt(byte, 16))
      : undefined;
    const resolved =
      hexBytes === undefined
        ? destination.match(/^(?:(?<user>.*)@)?(?<hostName>.+?)$/)?.groups
        : JSON.parse(new TextDecoder().decode(new Uint8Array(hexBytes)));
    expect({ user: resolved?.user, hostName: resolved?.hostName }).toEqual({
      user: "vm+demo",
      hostName: "ssh.example.com",
    });
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
