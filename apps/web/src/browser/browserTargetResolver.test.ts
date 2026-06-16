import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readEnvironmentConnection = vi.fn();

vi.mock("~/environments/runtime", () => ({ readEnvironmentConnection }));

describe("browser target resolver", () => {
  beforeEach(() => readEnvironmentConnection.mockReset());

  it("maps environment ports onto a private network host", async () => {
    readEnvironmentConnection.mockReturnValue({
      knownEnvironment: { target: { httpBaseUrl: "http://192.168.1.25:3773" } },
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/dashboard",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard",
      resolvedUrl: "http://192.168.1.25:5173/dashboard",
      resolutionKind: "direct-private-network",
      environmentId: "environment-1",
    });
  });

  it("refuses public relay hosts until the authenticated gateway exists", async () => {
    readEnvironmentConnection.mockReturnValue({
      knownEnvironment: { target: { httpBaseUrl: "https://relay.example.com" } },
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }),
    ).toThrow(/authenticated preview gateway/);
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readEnvironmentConnection.mockReturnValue({
      knownEnvironment: { target: { httpBaseUrl: "http://localhost:3773" } },
    });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");
  });

  it("normalizes public URLs without treating them as environment ports", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "example.com/app")).toBe(
      "https://example.com/app",
    );
  });

  it("supports private IPv6 environment hosts", async () => {
    readEnvironmentConnection.mockReturnValue({
      knownEnvironment: { target: { httpBaseUrl: "http://[::1]:3773" } },
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app?mode=test",
      }).resolvedUrl,
    ).toBe("http://[::1]:5173/app?mode=test");
  });

  it("leaves malformed input for the normal navigation error path", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "   ")).toBe("   ");
  });
});
