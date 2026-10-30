// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { codexAuthHandoffUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeEach, vi } from "vite-plus/test";

const clerkStateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-clerk-"));
afterAll(() => {
  NodeFS.rmSync(clerkStateDir, { recursive: true, force: true });
});

const { createClerkBridgeMock, requestSingleInstanceLockMock, storageAdapter, storageMock } =
  vi.hoisted(() => ({
    createClerkBridgeMock: vi.fn(),
    requestSingleInstanceLockMock: vi.fn(() => true),
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    storageMock: vi.fn(),
  }));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

const ignoreWebLinks = DesktopWebLinks.DesktopWebLinks.of({
  receive: () => Effect.void,
  setRendererReady: () => Effect.void,
});

const layerDesktopClerk = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "darwin",
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
  }),
  shell: ElectronShell.ElectronShell["Service"] = {
    openExternal: () => Effect.succeed(true),
    openSystemSettings: () => Effect.succeed(false),
    copyText: () => Effect.void,
  },
  listeners = new Map<string, (...args: unknown[]) => void>(),
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: clerkStateDir,
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return requestSingleInstanceLockMock();
    }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push(`on:${name}`);
          listeners.set(name, listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(name);
          }),
      ).pipe(Effect.asVoid),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePathLayer.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        fileSystemLayer,
      ),
    ),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    requestSingleInstanceLockMock.mockReset().mockReturnValue(true);
    storageMock.mockReset();
  });

  it.each([
    {
      name: "packaged macOS",
      isDevelopment: false,
      platform: "darwin" as const,
      userData: "/tmp/app-data/t3code-v2",
    },
    {
      name: "packaged Linux",
      isDevelopment: false,
      platform: "linux" as const,
      userData: "/tmp/app-data/t3code-v2",
    },
    {
      name: "packaged Windows",
      isDevelopment: false,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-v2",
    },
    {
      name: "development",
      isDevelopment: true,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-dev",
    },
  ])(
    "creates the bridge before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform, userData }) => {
      const events: string[] = [];
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        events.push("createClerkBridge");
        return { cleanup: vi.fn(), isPrimaryInstance: true };
      });
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(
          Layer.build(
            layerDesktopClerk(isDevelopment, events, platform, DesktopPreReadyFileSystem.layer),
          ),
        ),
      );

      assert.deepEqual(events, [
        `setPath:userData:${userData}`,
        "requestSingleInstanceLock",
        "on:second-instance",
        "on:open-url",
        "createClerkBridge",
      ]);
      assert.deepEqual(storageMock.mock.calls, [
        [{ path: NodePath.join(NodePath.resolve(clerkStateDir), "clerk") }],
      ]);
      assert.notStrictEqual(createClerkBridgeMock.mock.calls[0]?.[0]?.storage, storageAdapter);
    },
  );

  it.effect.each(["before configure", "after configure"] as const)(
    "reveals the running window when a second instance launches %s",
    (entry) => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const quit = vi.fn();
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const revealed = Promise.withResolvers<unknown>();
      const window = { id: 1 };
      const electronApp = {
        quit: Effect.sync(quit),
        on: (eventName: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(eventName, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      const electronWindow = {
        currentMainOrFirst: Effect.succeedSome(window),
        reveal: (value: unknown) => Effect.sync(() => revealed.resolve(value)),
      } as unknown as ElectronWindow.ElectronWindow["Service"];

      return Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        if (entry === "before configure") listeners.get("second-instance")?.({}, ["t3"]);
        yield* clerk.configure;

        assert.equal(quit.mock.calls.length, 0);
        if (entry === "after configure") listeners.get("second-instance")!({}, ["t3"]);
        assert.strictEqual(yield* Effect.promise(() => revealed.promise), window);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
    },
  );

  it.effect("delivers each queued startup link once, before later links", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const received: string[] = [];
    const first = "t3code://new?prompt=first";
    const second = "t3code://threads/env-1/thread-1";
    const later = "t3code://new?prompt=later";
    const launchPair = "t3code://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    const delivered = Promise.withResolvers<void>();
    const electronApp = {
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      listeners.get("second-instance")?.({}, ["t3", first]);
      listeners.get("second-instance")?.({}, ["t3", second]);
      listeners.get("open-url")?.({ preventDefault: () => undefined }, launchPair);
      assert.deepEqual(received, []);

      yield* clerk.configure;
      listeners.get("second-instance")!({}, ["t3", later]);
      yield* Effect.promise(() => delivered.promise);

      assert.deepEqual(received, [launchPair, first, second, later]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) =>
            Effect.sync(() => {
              received.push(url);
              if (url === later) delivered.resolve();
            }),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  });

  it.effect.each(["darwin", "win32", "linux"] as const)(
    "quits a second launch before initializing Clerk or the application runtime on %s",
    (platform) =>
      Effect.gen(function* () {
        requestSingleInstanceLockMock.mockReturnValueOnce(false);
        createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
        const events: string[] = [];
        const runtime = layerDesktopClerk(false, events, platform).pipe(
          Layer.flatMap(() =>
            Layer.effectDiscard(
              Effect.sync(() => {
                events.push("initializeApplicationRuntime");
              }),
            ),
          ),
        );
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(runtime)));

        assert.isTrue(Exit.hasInterrupts(exit));
        assert.deepEqual(events, [
          "setPath:userData:/tmp/app-data/t3code-v2",
          "requestSingleInstanceLock",
          "quit",
        ]);
        assert.equal(createClerkBridgeMock.mock.calls.length, 0);
        assert.equal(storageMock.mock.calls.length, 0);
      }),
  );
});

it.effect(
  "provider auth deep links navigate and reveal the running desktop without handling Clerk URLs",
  () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const revealed = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const window = { loadURL };
    const electronApp = {
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeedSome(window),
      reveal: () => Effect.sync(() => revealed.resolve()),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const event = { preventDefault: vi.fn() };
      listeners.get("open-url")!(event, "t3code-dev://app/auth/callback?code=clerk-code");
      listeners.get("open-url")!(event, "t3code://app/welcome");
      assert.equal(loadURL.mock.calls.length, 0);
      assert.equal(event.preventDefault.mock.calls.length, 0);
      listeners.get("second-instance")!({}, [
        "t3",
        "t3code-dev://app/settings/providers?instanceId=work&code=never-forward",
      ]);
      yield* Effect.promise(() => revealed.promise);
      assert.deepEqual(loadURL.mock.calls, [
        ["t3code-dev://app/settings/providers?instanceId=work"],
      ]);
      listeners.get("open-url")!(event, "t3code-dev://app/welcome#agents:machine-id");
      assert.equal(event.preventDefault.mock.calls.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  },
);

it.effect.each(["startup", "open-url", "early-second-instance"] as const)(
  "receives hosted web sign-in through the desktop %s handler",
  (entry) =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const port = yield* Effect.promise(async () => {
        const server = NodeHttp.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("address");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return address.port;
      });
      const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
      authorize.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      const request = {
        authorizationUrl: authorize.toString(),
        returnUrl: "https://app.t3.codes/welcome#agents:remote-one",
        environmentId: EnvironmentId.make("remote-one"),
        instanceId: ProviderInstanceId.make("work"),
        flowId: "flow-one",
      };
      const link = codexAuthHandoffUrl(request, true);
      const delivered = Promise.withResolvers<string>();
      const shell = ElectronShell.ElectronShell.of({
        openExternal: (value) =>
          Effect.promise(async () => {
            const url = new URL(String(value));
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.search = new URLSearchParams({
              state: url.searchParams.get("state")!,
              code: "test-code",
              client_id: "oaiapp_test",
            }).toString();
            const response = await fetch(callback, { redirect: "manual" });
            delivered.resolve(response.headers.get("location")!);
            return true;
          }),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const electronApp = {
        whenReady: Effect.void,
        on: (name: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(name, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        if (entry === "early-second-instance") {
          listeners.get("second-instance")?.({}, ["t3", link]);
        }
        yield* clerk.configure;
        if (entry === "open-url") {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, link);
          assert.strictEqual(event.preventDefault.mock.calls.length, 1);
        }
        const delivery = readCodexAuthDelivery(yield* Effect.promise(() => delivered.promise));
        assert.strictEqual(delivery?.environmentId, request.environmentId);
        assert.strictEqual(delivery?.instanceId, request.instanceId);
        assert.strictEqual(delivery?.flowId, request.flowId);
        assert.strictEqual(delivery?.returnUrl, request.returnUrl);
      }).pipe(
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell, listeners)),
        Effect.provideService(HostProcess.Arguments, entry === "startup" ? ["t3", link] : ["t3"]),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(
          ElectronWindow.ElectronWindow,
          {} as ElectronWindow.ElectronWindow["Service"],
        ),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
    }).pipe(Effect.scoped),
);

it.effect("hands web and app links to the renderer and leaves other links alone", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const received: Array<string> = [];
    const pairLink = "t3code://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const open = (url: string) => {
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(event, url);
        return event.preventDefault.mock.calls.length;
      };
      assert.strictEqual(open("https://example.com/page"), 1);
      assert.strictEqual(open("http://localhost:3000/"), 1);
      assert.strictEqual(open("t3code://new?prompt=hi"), 1);
      assert.strictEqual(open("t3code://threads/env-1/thread-1"), 1);
      assert.strictEqual(open(pairLink), 1);
      assert.strictEqual(open("t3code://pair"), 0);
      assert.strictEqual(open("mailto:hello@example.com"), 0);
      assert.strictEqual(open("t3code://somewhere-else"), 0);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(received, [
        "https://example.com/page",
        "http://localhost:3000/",
        "t3code://new?prompt=hi",
        "t3code://threads/env-1/thread-1",
        pairLink,
      ]);
    }).pipe(
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) => Effect.sync(() => void received.push(url)),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);
