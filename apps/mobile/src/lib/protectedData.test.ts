import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  appState: "background" as string | null,
  nativeCheckSupported: true,
  platform: "ios",
  webSocketSupported: true,
  subscribed: Promise.withResolvers<void>(),
  listeners: new Set<(state: string) => void>(),
  isProtectedDataAvailable: vi.fn<() => Promise<boolean>>(),
  readStorage: vi.fn<() => Promise<void>>(),
  webSocketConnect: vi.fn<(id: number, url: string, protocols: Array<string>) => void>(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => {
    if (name === "T3NativeControls") {
      return {
        ...(mocks.nativeCheckSupported && {
          isProtectedDataAvailable: mocks.isProtectedDataAvailable,
        }),
      };
    }
    if (name === "T3WebSocket" && mocks.webSocketSupported) {
      return {
        connect: mocks.webSocketConnect,
        close: () => undefined,
        addListener: () => ({ remove: () => undefined }),
      };
    }
    return null;
  },
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.platform;
    },
  },
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      mocks.subscribed.resolve();
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));

vi.mock("../persistence/layer", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  return { layer: Layer.effectDiscard(Effect.promise(mocks.readStorage)) };
});
vi.mock("../features/cloud/dpop", async () => ({
  layer: (await import("effect/Layer")).empty,
}));
vi.mock("../features/cloud/managedRelayLayer", async () => {
  const Layer = await import("effect/Layer");
  return { layer: () => Layer.empty };
});
vi.mock("../features/cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relay: { url: null } }),
}));
vi.mock("../features/observability/tracing", async () => ({
  layer: (await import("effect/Layer")).empty,
}));
vi.mock("@t3tools/client-runtime/rpc", async () => {
  const Layer = await import("effect/Layer");
  return { layerRemoteHttpClient: () => Layer.empty };
});

let runtime: typeof import("./runtime").runtime | undefined;

beforeEach(() => {
  vi.resetModules();
  mocks.appState = "background";
  mocks.nativeCheckSupported = true;
  mocks.platform = "ios";
  mocks.webSocketSupported = true;
  mocks.subscribed = Promise.withResolvers<void>();
  mocks.listeners.clear();
  mocks.isProtectedDataAvailable.mockReset();
  mocks.readStorage.mockReset().mockResolvedValue(undefined);
  mocks.webSocketConnect.mockReset();
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  vi.unstubAllGlobals();
});

describe("protected storage startup", () => {
  it.each([
    { launch: "background", state: "background", checkRejects: false },
    { launch: "background with a failed native check", state: "background", checkRejects: true },
    { launch: "unset without a native check", state: null, nativeCheckSupported: false },
  ])(
    "keeps a locked $launch launch usable after activation without rebuilding its runtime",
    async (scenario) => {
      mocks.appState = scenario.state;
      mocks.nativeCheckSupported = scenario.nativeCheckSupported ?? true;
      mocks.isProtectedDataAvailable.mockImplementation(async () => {
        if (scenario.checkRejects) throw new Error("Protected data check unavailable.");
        return false;
      });
      mocks.readStorage.mockImplementation(async () => {
        if (mocks.appState !== "active") throw new Error("User interaction is not allowed.");
      });
      ({ runtime } = await import("./runtime"));
      const startup = runtime.runPromiseExit(Effect.succeed("ready"));

      // A missing gate finishes startup with a cached storage failure instead.
      await Promise.race([mocks.subscribed.promise, startup]);
      expect(mocks.readStorage).not.toHaveBeenCalled();
      mocks.appState = "inactive";
      for (const listener of mocks.listeners) listener("inactive");
      await Promise.resolve();
      expect(mocks.readStorage).not.toHaveBeenCalled();

      mocks.appState = "active";
      for (const listener of mocks.listeners) listener("active");
      expect(await startup).toMatchObject({ _tag: "Success", value: "ready" });
      expect(await runtime.runPromise(Effect.succeed("still ready"))).toBe("still ready");
      expect(mocks.readStorage).toHaveBeenCalledOnce();
      expect(mocks.listeners.size).toBe(0);
      mocks.appState = "background";
      await (await import("./protectedData")).whenProtectedDataAvailable();
      expect(mocks.isProtectedDataAvailable).toHaveBeenCalledTimes(
        mocks.nativeCheckSupported ? 1 : 0,
      );
    },
  );
});

describe("runtime WebSocket", () => {
  it.each([
    { platform: "android", webSocketSupported: true },
    { platform: "ios", webSocketSupported: false },
  ])(
    "keeps the global socket on $platform with native support $webSocketSupported",
    async (scenario) => {
      mocks.appState = "active";
      mocks.platform = scenario.platform;
      mocks.webSocketSupported = scenario.webSocketSupported;
      const globalWebSocket = vi.fn(function () {});
      vi.stubGlobal("WebSocket", globalWebSocket);
      ({ runtime } = await import("./runtime"));

      const makeWebSocket = await runtime.runPromise(Socket.WebSocketConstructor);
      makeWebSocket("wss://host.test/ws");

      expect(globalWebSocket).toHaveBeenCalledWith("wss://host.test/ws", undefined);
      expect(mocks.webSocketConnect).not.toHaveBeenCalled();
    },
  );

  it("dials iOS sockets through URLSession instead of React Native's WebSocket", async () => {
    mocks.appState = "active";
    // React Native's iOS WebSocket is SocketRocket, which never offers permessage-deflate.
    const globalWebSocket = vi.fn();
    vi.stubGlobal("WebSocket", globalWebSocket);
    ({ runtime } = await import("./runtime"));

    const makeWebSocket = await runtime.runPromise(Socket.WebSocketConstructor);
    makeWebSocket("wss://host.test/ws");

    expect(globalWebSocket).not.toHaveBeenCalled();
    expect(mocks.webSocketConnect).toHaveBeenCalledWith(
      expect.any(Number),
      "wss://host.test/ws",
      [],
    );
  });
});
