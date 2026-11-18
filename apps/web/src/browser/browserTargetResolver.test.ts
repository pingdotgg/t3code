import { EnvironmentId } from "@t3tools/contracts";
import { isPrivateNetworkHost, isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
const env = vi.hoisted(() => ({ isElectron: false }));
const preview = vi.hoisted(() => ({ desktop: false, serverBrowser: false, clientHost: false }));

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/env", () => env);
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => preview.desktop }));
vi.mock("~/state/clientHostEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { clientHostEnvironmentAtom: () => Atom.make(() => preview.clientHost) };
});
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => preview.serverBrowser,
  useEnvironmentSupportsServerBrowser: () => preview.serverBrowser,
}));

const remoteBearer = { _tag: "BearerConnectionTarget", connectionId: "saved:remote" };

describe("browser target resolver", () => {
  beforeEach(() => readPreparedConnection.mockReset());

  it("refuses public relay hosts until the authenticated gateway exists", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "http://localhost:5173"),
    ).toBe("http://localhost:5173");
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://localhost:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");
  });

  it("maps discovered loopback servers onto a remote environment host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3000/app"),
    ).toBe("http://192.168.1.25:3000/app");
  });

  it("keeps localhost for servers on the desktop's own WSL or primary backend", async () => {
    // WSL NAT advertises a distro IP, but loopback-bound servers only answer on localhost.
    const { isEnvironmentHostLoopbackUrl, resolveDiscoveredServerUrl } =
      await import("./browserTargetResolver");
    env.isElectron = true;
    try {
      for (const target of [
        { _tag: "BearerConnectionTarget", connectionId: "local:wsl:Ubuntu" },
        { _tag: "PrimaryConnectionTarget" },
      ]) {
        readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://172.24.66.27:3773", target });
        expect(
          resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3001/"),
        ).toBe("http://localhost:3001/");
        expect(
          isEnvironmentHostLoopbackUrl(
            EnvironmentId.make("environment-1"),
            "http://localhost:3001/",
          ),
        ).toBe(false);
      }
      readPreparedConnection.mockReturnValue({
        httpBaseUrl: "http://192.168.1.25:3773",
        target: { _tag: "BearerConnectionTarget", connectionId: "saved:remote" },
      });
      expect(
        resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3001/"),
      ).toBe("http://192.168.1.25:3001/");
    } finally {
      env.isElectron = false;
    }
  });

  it("treats loopback links as the host's only when the environment is on another machine", async () => {
    const { isEnvironmentHostLoopbackUrl, resolveClientBrowserUrl } =
      await import("./browserTargetResolver");
    const environmentId = EnvironmentId.make("environment-1");
    const ssh = { _tag: "SshConnectionTarget" };
    const cases = [
      ["http://100.101.102.103:3773", remoteBearer, "http://127.0.0.1:5173/", true],
      ["https://devbox.tail1234.ts.net", remoteBearer, "http://localhost:5173/app", true],
      ["https://relay.example.com", { _tag: "RelayConnectionTarget" }, "http://[::1]:5173/", true],
      // The SSH forward's own origin is this client's route to the server, not the host's loopback.
      ["http://127.0.0.1:49152", ssh, "http://localhost:5173/", true],
      ["http://127.0.0.1:49152", ssh, "http://127.0.0.1:49152/assets/a.html", false],
      [
        "http://localhost:3773",
        { _tag: "PrimaryConnectionTarget" },
        "http://localhost:5173/",
        false,
      ],
      ["http://100.101.102.103:3773", remoteBearer, "https://example.com/", false],
      ["http://100.101.102.103:3773", remoteBearer, "mailto:dev@example.com", false],
    ] as const;
    for (const [httpBaseUrl, target, url, expected] of cases) {
      readPreparedConnection.mockReturnValue({ httpBaseUrl, target });
      expect({
        httpBaseUrl,
        url,
        hostOnly: isEnvironmentHostLoopbackUrl(environmentId, url),
      }).toEqual({ httpBaseUrl, url, hostOnly: expected });
    }

    // The desktop's own server reached through T3 Connect is still this machine.
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://relay.example.com",
      target: { _tag: "RelayConnectionTarget" },
    });
    preview.clientHost = true;
    try {
      expect(isEnvironmentHostLoopbackUrl(environmentId, "http://127.0.0.1:5173/")).toBe(false);
    } finally {
      preview.clientHost = false;
    }

    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://100.101.102.103:3773",
      target: remoteBearer,
    });
    expect(resolveClientBrowserUrl(environmentId, "http://127.0.0.1:5173/play?seed=1#map")).toBe(
      "http://100.101.102.103:5173/play?seed=1#map",
    );
    expect(resolveClientBrowserUrl(environmentId, "https://example.com/a")).toBe(
      "https://example.com/a",
    );
  });

  it("opens the host's loopback links in the host's browser, which reaches any bind", async () => {
    const { previewTargetForLink } = await import("./previewRuntime");
    const environmentId = EnvironmentId.make("environment-1");
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://100.101.102.103:3773",
      target: remoteBearer,
    });
    preview.desktop = true;
    try {
      preview.serverBrowser = true;
      expect(previewTargetForLink(environmentId, "http://127.0.0.1:5173/")).toEqual({
        url: "http://127.0.0.1:5173/",
        runtime: "server",
      });
      // The desktop still opens a remote environment's other links on this computer.
      expect(previewTargetForLink(environmentId, "https://example.com/")).toEqual({
        url: "https://example.com/",
        runtime: undefined,
      });
      preview.serverBrowser = false;
      expect(previewTargetForLink(environmentId, "http://127.0.0.1:5173/")).toEqual({
        url: "http://100.101.102.103:5173/",
        runtime: undefined,
      });
    } finally {
      preview.desktop = false;
      preview.serverBrowser = false;
    }
  });

  it("classifies exact private IPv4 and IPv6 boundaries", async () => {
    const privateHosts = [
      "0.0.0.0",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.0",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "fc00::",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.168.1.1",
      "localhost.",
      "localhost..",
      "devbox.",
      "devbox..",
      "printer.local.",
      "printer.local..",
      "printer.home.arpa.",
      "printer.home.arpa..",
      "devbox.example.ts.net.",
      "devbox.example.ts.net..",
    ];
    const publicHosts = [
      "1.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "fbff:ffff::",
      "fec0::",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "example.com.",
    ];
    expect(privateHosts.filter((host) => !isPrivateNetworkHost(host))).toEqual([]);
    expect(publicHosts.filter(isPrivateNetworkHost)).toEqual([]);
  });

  it("allows only globally routable hosts to reach a public favicon provider", async () => {
    const nonPublic = [
      "192.0.0.0",
      "192.0.0.255",
      "192.0.2.0",
      "192.0.2.255",
      "192.88.99.0",
      "192.88.99.255",
      "198.51.100.0",
      "198.51.100.255",
      "203.0.113.0",
      "203.0.113.255",
      "224.0.0.0",
      "255.255.255.255",
      "::2",
      "100::",
      "100::ffff:ffff:ffff:ffff",
      "100:0:0:1::",
      "100:0:0:1:ffff:ffff:ffff:ffff",
      "64:ff9b:1::1",
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::c0a8:101",
      "64:ff9b::c000:201",
      "2001:5::1",
      "2001:2::",
      "2001:2:0:ffff:ffff:ffff:ffff:ffff",
      "2001:db8::",
      "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff::",
      "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "5f00::1",
      "fec0::",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.0.2.1",
      "app.test",
      "app.test..",
      "printer.local..",
      "printer.home.arpa..",
      "devbox.example.ts.net..",
      "127.0.0.1..",
      "127.1..",
      "10.1..",
      "172.16.1..",
      "192.168.1..",
      "service.internal",
      "hidden.onion",
    ];
    const publicHosts = [
      "191.255.255.255",
      "192.0.1.255",
      "192.0.3.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "1.1.1.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "64:ff9b::808:808",
      "2001:1::1",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
      "::ffff:8.8.8.8",
      "example.com",
      "example.com.",
    ];
    expect(nonPublic.filter(isPublicFaviconHost)).toEqual([]);
    expect(publicHosts.filter((host) => !isPublicFaviconHost(host))).toEqual([]);
  });
});
