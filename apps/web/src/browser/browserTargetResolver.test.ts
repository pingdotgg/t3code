import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));

describe("browser target resolver", () => {
  beforeEach(() => readPreparedConnection.mockReset());

  it("maps environment ports onto a private network host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
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
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");

    try {
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      });
      expect.unreachable("Expected public environment host resolution to fail");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "BrowserTargetPrivateNetworkRequiredError",
        environmentId: "environment-1",
        hostname: "relay.example.com",
        message:
          "Environment environment-1 host relay.example.com needs the planned authenticated preview gateway because it is not directly private-network reachable.",
      });
    }
  });

  it("identifies the disconnected environment", async () => {
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");

    try {
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      });
      expect.unreachable("Expected disconnected environment resolution to fail");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "BrowserTargetEnvironmentDisconnectedError",
        environmentId: "environment-1",
        message: "Environment environment-1 is not connected.",
      });
    }
  });

  it("preserves invalid environment URL causes with connection context", async () => {
    const sensitiveUrl =
      "https://user:password@[invalid-host]/private/workspace?access_token=secret#fragment";
    readPreparedConnection.mockReturnValue({ httpBaseUrl: sensitiveUrl });
    const { BrowserTargetEnvironmentUrlInvalidError, resolveBrowserNavigationTarget } =
      await import("./browserTargetResolver");

    try {
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      });
      expect.unreachable("Expected browser target resolution to fail");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "BrowserTargetEnvironmentUrlInvalidError",
        environmentId: "environment-1",
        httpBaseUrlInputLength: sensitiveUrl.length,
        cause: expect.any(TypeError),
        message: `Environment environment-1 has an invalid HTTP base URL input of length ${sensitiveUrl.length}.`,
      });
      expect(error).toBeInstanceOf(BrowserTargetEnvironmentUrlInvalidError);
      expect(error).not.toHaveProperty("httpBaseUrl");
      expect(error).not.toHaveProperty("httpBaseUrlProtocol");
      expect(error).not.toHaveProperty("httpBaseUrlHostname");
      expect(String((error as Error).message)).not.toMatch(
        /user|password|private|workspace|access_token|secret|fragment/,
      );
    }
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

  it("normalizes public URLs without treating them as environment ports", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "example.com/app")).toBe(
      "https://example.com/app",
    );
  });

  it("supports private IPv6 environment hosts", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://[::1]:3773" });
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
