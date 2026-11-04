import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../test/render";

const gateway = vi.hoisted(() => ({ connect: vi.fn(), stop: vi.fn(), mount: vi.fn() }));
vi.mock(import("@t3tools/client-runtime/gateway"), async (original) => ({
  ...(await original()),
  connectGatewayBridge: gateway.connect,
  createGatewayRuntimePortFromContext: vi.fn(),
  createGatewayRuntimeEventSourceFromContext: vi.fn(),
}));
vi.mock(import("./connection/runtime"), () => ({ connectionAtomRuntime: {} as never }));
vi.mock(import("./rpc/atomRegistry"), () => ({
  appAtomRegistry: {
    mount: gateway.mount,
    get: () => AsyncResult.success({}),
    subscribe: () => () => {},
  } as never,
}));

import { McpGatewayHost } from "./McpGatewayHost";
import {
  getMcpGatewayStartup,
  getMcpGatewayStatus,
  MCP_GATEWAY_ENABLED_KEY,
  MCP_GATEWAY_TOKEN_KEY,
  restartMcpGateway,
} from "./mcpGatewayState";
import type { AppRouter } from "./router";

function enabledGateway(): Disposable {
  vi.clearAllMocks();
  gateway.mount.mockReturnValue(() => {});
  localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, "true");
  sessionStorage.setItem(MCP_GATEWAY_TOKEN_KEY, "test-token-with-enough-characters");
  return {
    [Symbol.dispose]() {
      localStorage.removeItem(MCP_GATEWAY_ENABLED_KEY);
      sessionStorage.removeItem(MCP_GATEWAY_TOKEN_KEY);
    },
  };
}

it("keeps older desktop shells usable without mounting an unsupported gateway", async () => {
  using _gateway = enabledGateway();
  using _bridge = stubGlobal("desktopBridge", {});
  await using _screen = await render(<McpGatewayHost router={{} as AppRouter} />, {
    router: false,
  });
  expect(gateway.mount).not.toHaveBeenCalled();
  expect(gateway.connect).not.toHaveBeenCalled();
});

it("restarts the configured profile gateway through desktop IPC and replaces its bridge", async () => {
  using _gateway = enabledGateway();
  const configure = vi.fn().mockResolvedValue(undefined);
  gateway.connect.mockReturnValue({ stop: gateway.stop, requestStatus: () => true });
  using _bridge = stubGlobal("desktopBridge", {
    getMcpGatewayLaunchConfig: () => ({}),
    configureManagedMcpGateway: configure,
  });
  {
    await using _screen = await render(<McpGatewayHost router={{} as AppRouter} />, {
      router: false,
    });
    expect(gateway.connect).toHaveBeenCalledTimes(1);
    await act(() => {
      expect(restartMcpGateway()).toBe(true);
    });
    expect(gateway.stop).toHaveBeenCalledOnce();
    expect(gateway.connect).toHaveBeenCalledTimes(2);
    expect(configure.mock.calls.map(([input]) => (input === null ? "stop" : "start"))).toEqual([
      "start",
      "stop",
      "start",
    ]);
    expect(configure.mock.calls[2]?.[0]).toEqual(configure.mock.calls[0]?.[0]);

    using _console = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configure.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("startup failed"));
    await act(() => {
      restartMcpGateway();
    });
    expect(getMcpGatewayStatus()).toBe("degraded");
  }
  expect(restartMcpGateway()).toBe(false);
});

it("reports a missing bridge token instead of a started gateway, including on restart", async () => {
  using _gateway = enabledGateway();
  sessionStorage.removeItem(MCP_GATEWAY_TOKEN_KEY);
  const configure = vi.fn().mockResolvedValue(undefined);
  using _bridge = stubGlobal("desktopBridge", {
    getMcpGatewayLaunchConfig: () => ({}),
    getMcpGatewayBridgeToken: () => null,
    configureManagedMcpGateway: configure,
  });
  await using _screen = await render(<McpGatewayHost router={{} as AppRouter} />, {
    router: false,
  });
  await vi.waitFor(() => expect(getMcpGatewayStartup()).toMatchObject({ phase: "failed" }));
  await act(() => {
    expect(restartMcpGateway()).toBe(true);
  });
  await vi.waitFor(() =>
    expect(getMcpGatewayStartup()).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("has no bridge token"),
    }),
  );
  expect(configure.mock.calls.every(([input]) => input === null)).toBe(true);
  expect(gateway.connect).not.toHaveBeenCalled();
});

it("starts an enabled gateway with a durable token the desktop creates after a restart", async () => {
  using _gateway = enabledGateway();
  // An app restart drops the session token; the desktop then has none until it creates one.
  sessionStorage.removeItem(MCP_GATEWAY_TOKEN_KEY);
  let stored: string | null = null;
  const configure = vi.fn().mockResolvedValue(undefined);
  gateway.connect.mockReturnValue({ stop: gateway.stop, requestStatus: () => true });
  using _bridge = stubGlobal("desktopBridge", {
    getMcpGatewayLaunchConfig: () => ({}),
    getMcpGatewayBridgeToken: () => stored,
    ensureMcpGatewayBridgeToken: () => (stored = "durable-token-0123456789abcdef"),
    configureManagedMcpGateway: configure,
  });
  await using _screen = await render(<McpGatewayHost router={{} as AppRouter} />, {
    router: false,
  });
  await vi.waitFor(() => expect(getMcpGatewayStartup()).toEqual({ phase: "ready" }));
  expect(configure).toHaveBeenCalledWith({ token: "durable-token-0123456789abcdef", port: 47631 });
  expect(gateway.connect).toHaveBeenCalledOnce();
});
