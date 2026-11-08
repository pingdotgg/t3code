import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { isPrivateNetworkHost, isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
const openSandboxPreviewRun = vi.fn();
const env = vi.hoisted(() => ({ isElectron: false }));

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/connection/cloudSandbox", () => ({
  openSandboxPreview: { run: openSandboxPreviewRun },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => null },
}));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/env", () => env);

describe("browser target resolver", () => {
  beforeEach(() => {
    readPreparedConnection.mockReset();
    openSandboxPreviewRun.mockReset();
  });

  it("returns the raw URL for a public relay host instead of the client localhost", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://relay.example.com",
      target: { _tag: "BearerConnectionTarget" },
    });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "http://localhost:5173"),
    ).toBe("http://localhost:5173");
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://localhost:3773",
      target: { _tag: "BearerConnectionTarget" },
    });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");

    // A sandbox's loopback is its own, so the normalized URL is kept rather than mapped.
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://tunnel.example.com/sb",
      target: { _tag: "CloudSandboxConnectionTarget" },
    });
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("sandbox-normalize"), "localhost:5173"),
    ).toBe("http://localhost:5173/");
  });

  it("maps discovered loopback servers onto a remote environment host", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://192.168.1.25:3773",
      target: { _tag: "BearerConnectionTarget" },
    });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3000/app"),
    ).toBe("http://192.168.1.25:3000/app");

    const sandboxEnvironment = EnvironmentId.make("sandbox-environment-1");
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://tunnel.example.com/sb",
      target: { _tag: "CloudSandboxConnectionTarget", environmentId: sandboxEnvironment },
    });
    const { resolveServerOwnedUrl, resolveExternalServerUrl, releaseExternalServerUrl } =
      await import("./browserTargetResolver");
    const hostedFor = (serverOwned: string) =>
      `https://d.example.com/pfx${new URL(serverOwned).pathname}${new URL(serverOwned).search}&t=ymmc`;
    openSandboxPreviewRun.mockImplementation((_registry, input) =>
      Promise.resolve(
        input.close === true
          ? AsyncResult.success({ url: input.url })
          : AsyncResult.success({ url: hostedFor(input.url) }),
      ),
    );

    // Non-aliases pass through untouched; the sandbox's own loopback form is kept.
    expect(resolveServerOwnedUrl(sandboxEnvironment, "https://plain.example.com")).toBe(
      "https://plain.example.com",
    );
    expect(resolveServerOwnedUrl(sandboxEnvironment, "http://localhost:3000/app")).toBe(
      "http://localhost:3000/app",
    );

    // Hosting a loopback service resolves through the sandbox's controller.
    const hosted = await resolveExternalServerUrl(
      sandboxEnvironment,
      "http://localhost:3000/app?x=1",
    );
    expect(hosted).toBe("https://d.example.com/pfx/app?x=1&t=ymmc");
    expect(openSandboxPreviewRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: sandboxEnvironment,
        url: "http://localhost:3000/app?x=1",
        local: false,
      }),
    );

    // The alias maps back to its server-owned form, without the provider token.
    expect(resolveServerOwnedUrl(sandboxEnvironment, hosted)).toBe("http://localhost:3000/app?x=1");

    // Re-resolving an alias re-mints a fresh hosted URL from the server form.
    await expect(resolveExternalServerUrl(sandboxEnvironment, `${hosted}&z=2`)).resolves.toBe(
      "https://d.example.com/pfx/app?x=1&z=2&t=ymmc",
    );
    expect(openSandboxPreviewRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ url: "http://localhost:3000/app?x=1&z=2" }),
    );

    // Releasing an alias closes its hosting session.
    await releaseExternalServerUrl(
      sandboxEnvironment,
      "https://d.example.com/pfx/app?x=1&z=2&t=ymmc",
    );
    expect(openSandboxPreviewRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ close: true }),
    );

    // Sandbox URLs that are not loopback services load directly.
    await expect(
      resolveExternalServerUrl(sandboxEnvironment, "https://plain.example.com/site"),
    ).resolves.toBe("https://plain.example.com/site");
    expect(openSandboxPreviewRun).toHaveBeenCalledTimes(3);
  });

  it("forgets a forwarded loopback alias once its close has been sent", async () => {
    const sandboxEnvironment = EnvironmentId.make("sandbox-close-1");
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://tunnel.example.com/sb",
      target: { _tag: "CloudSandboxConnectionTarget", environmentId: sandboxEnvironment },
    });
    const { resolveServerOwnedUrl, resolveExternalServerUrl, releaseExternalServerUrl } =
      await import("./browserTargetResolver");
    openSandboxPreviewRun.mockImplementation((_registry, input) =>
      Promise.resolve(
        AsyncResult.success({
          url:
            input.close === true
              ? input.url
              : `http://127.0.0.1:47123${new URL(input.url).pathname}`,
        }),
      ),
    );

    const forwarded = await resolveExternalServerUrl(
      sandboxEnvironment,
      "http://localhost:3000/app",
    );
    expect(forwarded).toBe("http://127.0.0.1:47123/app");
    expect(resolveServerOwnedUrl(sandboxEnvironment, forwarded)).toBe("http://localhost:3000/app");

    await releaseExternalServerUrl(sandboxEnvironment, forwarded);
    expect(openSandboxPreviewRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ url: forwarded, close: true }),
    );
    expect(resolveServerOwnedUrl(sandboxEnvironment, forwarded)).toBe(forwarded);
  });

  it("keeps localhost for servers on the desktop's own WSL or primary backend", async () => {
    // WSL NAT advertises a distro IP, but loopback-bound servers only answer on localhost.
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
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
      expect(
        resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3001/"),
      ).toBe("http://192.168.1.25:3001/");
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
