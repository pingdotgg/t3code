import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveCritForwarding } from "./useOpenInCrit.logic";

const environmentId = EnvironmentId.make("crit-environment");
const base = { environmentId, label: "Crit environment" };
const sshTarget: DesktopSshEnvironmentTarget = {
  alias: "dev",
  hostname: "dev.example",
  username: "user",
  port: 22,
};
const ssh: ConnectionRoute = {
  target: new SshConnectionTarget({ ...base, connectionId: "ssh" }),
  profile: Option.some(
    new SshConnectionProfile({
      ...base,
      connectionId: "ssh",
      target: sshTarget,
    }),
  ),
};

function bearer(httpBaseUrl: string, network?: "tailscale"): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({ ...base, connectionId: "direct" }),
    profile: Option.some(
      new BearerConnectionProfile({
        ...base,
        connectionId: "direct",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        ...(network ? { network } : {}),
      }),
    ),
  };
}

function entry(preferred: ConnectionRoute, alternate: ConnectionRoute): ConnectionCatalogEntry {
  return { ...preferred, enabled: true, alternateRoutes: [alternate] };
}

function prepared(route: ConnectionRoute, httpBaseUrl: string): PreparedConnection {
  return {
    ...base,
    target: route.target,
    httpBaseUrl,
    socketUrl: httpBaseUrl.replace(/^http/, "ws"),
    httpAuthorization: null,
  };
}

describe("Crit forwarding", () => {
  it("follows a reconnected SSH fallback rather than the preferred direct route", () => {
    const direct = bearer("https://dev.tail123.ts.net/");
    const catalog = entry(direct, ssh);
    expect(resolveCritForwarding(catalog, prepared(direct, "https://dev.tail123.ts.net/"))).toEqual(
      { kind: "tailscale" },
    );
    expect(resolveCritForwarding(catalog, prepared(ssh, "http://127.0.0.1:4444/"))).toEqual({
      kind: "ssh",
    });
  });

  it.each([
    ["https://dev.tail123.ts.net/", undefined],
    ["http://[fd7a:115c:a1e0::1]:3773/", undefined],
    ["http://100.64.1.2:3773/", "tailscale"],
  ] as const)("forwards the connected Tailscale route at %s", (url, network) => {
    const direct = bearer(url, network);
    expect(resolveCritForwarding(entry(ssh, direct), prepared(direct, url))).toEqual({
      kind: "tailscale",
    });
  });

  it("also forwards a remote web client's primary tailnet origin", () => {
    const httpBaseUrl = "https://dev.tail123.ts.net/";
    const primary: ConnectionRoute = {
      target: new PrimaryConnectionTarget({
        ...base,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
      profile: Option.none(),
    };
    expect(
      resolveCritForwarding({ ...primary, enabled: true }, prepared(primary, httpBaseUrl)),
    ).toEqual({ kind: "tailscale" });
  });

  it("keeps local reviews local and rejects unsupported or unprepared remote connections", () => {
    const local = bearer("http://127.0.0.1:3773/");
    const catalog = entry(local, ssh);
    expect(resolveCritForwarding(catalog, prepared(local, "http://127.0.0.1:3773/"))).toEqual({
      kind: "local",
    });
    expect(() => resolveCritForwarding(catalog, null)).toThrow("Wait for it to reconnect");
    const remote = bearer("https://dev.example/");
    expect(() =>
      resolveCritForwarding(entry(remote, ssh), prepared(remote, "https://dev.example/")),
    ).toThrow("Tailscale or SSH");
  });
});
