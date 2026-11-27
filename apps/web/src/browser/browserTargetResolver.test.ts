import { EnvironmentId } from "@t3tools/contracts";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
const env = vi.hoisted(() => ({ isElectron: false }));

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/env", () => env);

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
    const { resolveDiscoveredServerUrl, resolveExternalServerUrl } =
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
      }
      readPreparedConnection.mockReturnValue({
        httpBaseUrl: "http://192.168.1.25:3773",
        target: { _tag: "BearerConnectionTarget", connectionId: "saved:remote" },
      });
      // The webview's partition tunnels to the environment; the system browser has no tunnel.
      expect(
        resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3001/"),
      ).toBe("http://localhost:3001/");
      expect(resolveExternalServerUrl(EnvironmentId.make("environment-1"), "localhost:3001/")).toBe(
        "http://192.168.1.25:3001/",
      );
    } finally {
      env.isElectron = false;
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
});
