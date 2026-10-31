// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { codexAuthHandoffUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Electron from "electron";
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
import { cancelCodexAuthCallback } from "./CodexAuthCallback.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
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
          assert.isFalse(listeners.has(name), `duplicate ${name} listener`);
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

it.effect.each(["startup", "open-url", "early-second-instance", "cold-open-url"] as const)(
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
        if (entry === "cold-open-url") {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, link);
          assert.strictEqual(event.preventDefault.mock.calls.length, 1);
        }
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

it.effect(
  "delivers mixed macOS launch events once in order after startup and renderer readiness",
  () =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const probeStarted = yield* Deferred.make<void>();
      const finishProbe = yield* Deferred.make<void>();
      const warmDelivered = yield* Deferred.make<void>();
      const received: string[] = [];
      const pairingLink = buildPairingAppLink("https://example.com/?token=test-pairing");
      const webContents = Object.assign(new NodeEvents.EventEmitter(), {
        isDestroyed: () => false,
        send: (channel: string, url: string) => {
          assert.equal(channel, WEB_LINK_OPEN_CHANNEL);
          received.push(url);
        },
      });
      const window = { webContents } as unknown as Electron.BrowserWindow;
      const electronWindow = {
        currentMainOrFirst: Effect.succeedSome(window),
        reveal: () =>
          received.at(-1) === "https://example.com/warm"
            ? Deferred.succeed(warmDelivered, undefined).pipe(Effect.asVoid)
            : Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"];
      const shellEnvironment = DesktopShellEnvironment.DesktopShellEnvironment.of({
        installIntoProcess: Deferred.succeed(probeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishProbe)),
          Effect.as(true),
        ),
      });
      const open = (kind: "open-url" | "open-file", value: string) => {
        const event = { preventDefault: vi.fn() };
        listeners.get(kind)?.(event, value);
        return event.preventDefault;
      };

      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
        // DesktopApp acquires Clerk before shell probing, then configures its receivers.
        const startup = yield* shellEnvironment.installIntoProcess.pipe(
          Effect.andThen(clerk.configure),
          Effect.forkScoped,
        );
        yield* Deferred.await(probeStarted);
        open("open-url", "https://example.com/cold");
        open("open-file", "/tmp/report #1.html");
        open("open-url", "t3code://new?prompt=Fix+it");
        open("open-url", "t3code-dev://threads/env-1/thread-1");
        open("open-url", pairingLink);
        assert.equal(open("open-url", "mailto:hello@example.com").mock.calls.length, 0);
        assert.equal(open("open-file", "/tmp/report.txt").mock.calls.length, 0);
        assert.deepEqual(received, []);
        yield* Deferred.succeed(finishProbe, undefined);
        yield* Fiber.join(startup);
        assert.deepEqual(received, []);
        yield* webLinks.setRendererReady(true);
        const coldLinks = [
          "https://example.com/cold",
          "file:///tmp/report%20%231.html",
          "t3code://new?prompt=Fix+it",
          "t3code-dev://threads/env-1/thread-1",
          pairingLink,
        ];
        assert.deepEqual(received, coldLinks);
        open("open-file", "/tmp/warm.html");
        open("open-url", "https://example.com/warm");
        yield* Deferred.await(warmDelivered);
        yield* webLinks.setRendererReady(true);
        assert.deepEqual(received, [
          ...coldLinks,
          "file:///tmp/warm.html",
          "https://example.com/warm",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
        Effect.provideService(HostProcess.Arguments, ["t3"]),
        Effect.provide(DesktopWebLinks.layer),
        Effect.provideService(ElectronApp.ElectronApp, {
          on: (name: string, listener: (...args: unknown[]) => void) =>
            Effect.sync(() => {
              listeners.set(name, listener);
            }),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      );
    }),
);

it.effect.each(["window created", "startup cancelled"] as const)(
  "holds a cold provider-auth return until %s",
  (outcome) =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const windowAvailable = yield* Deferred.make<Electron.BrowserWindow>();
      const waiting = yield* Deferred.make<void>();
      const waitFinished = yield* Deferred.make<void>();
      const revealed = yield* Deferred.make<void>();
      const loadURL = vi.fn(async (_url: string) => undefined);
      const window = { loadURL, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
      const electronWindow = {
        main: Effect.succeedSome(window),
        waitForMain: Deferred.succeed(waiting, undefined).pipe(
          Effect.andThen(Deferred.await(windowAvailable)),
          Effect.ensuring(Deferred.succeed(waitFinished, undefined)),
        ),
        reveal: () => Deferred.succeed(revealed, undefined).pipe(Effect.asVoid),
      } as unknown as ElectronWindow.ElectronWindow["Service"];
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        const unrelated = { preventDefault: vi.fn() };
        listeners.get("open-url")!(unrelated, "t3code://app/settings/providers?instanceId=work");
        listeners.get("open-url")!(unrelated, "t3code-dev://app/auth/callback?code=clerk-code");
        assert.equal(unrelated.preventDefault.mock.calls.length, 0);
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(
          event,
          "t3code-dev://app/settings/providers?instanceId=work&code=never-forward",
        );
        assert.equal(event.preventDefault.mock.calls.length, 1);
        yield* clerk.configure;
        yield* Deferred.await(waiting);
        assert.deepEqual(loadURL.mock.calls, []);
        if (outcome === "window created") {
          yield* Deferred.succeed(windowAvailable, window);
          yield* Deferred.await(revealed);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
        Effect.provideService(ElectronApp.ElectronApp, {
          on: (name: string, listener: (...args: unknown[]) => void) =>
            Effect.sync(() => {
              listeners.set(name, listener);
            }),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
        Effect.provideService(HostProcess.Arguments, ["t3"]),
      );
      assert.isTrue(yield* Deferred.isDone(waitFinished));
      yield* Deferred.succeed(windowAvailable, window);
      assert.deepEqual(
        loadURL.mock.calls,
        outcome === "window created"
          ? [["t3code-dev://app/settings/providers?instanceId=work"]]
          : [],
      );
    }),
);

it.effect(
  "cancels a hosted sign-in and closes its callback listener with the configure scope",
  () =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
      const port = yield* Effect.promise(async () => {
        const server = NodeHttp.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("address");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return address.port;
      });
      const authorizationUrl = new URL("https://auth.openai.com/api/accounts/authorize");
      authorizationUrl.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
        state: "c".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      const link = codexAuthHandoffUrl(
        {
          authorizationUrl: authorizationUrl.toString(),
          returnUrl: "https://app.t3.codes/welcome",
          environmentId: EnvironmentId.make("remote-one"),
          instanceId: ProviderInstanceId.make("work"),
          flowId: "cancelled-flow",
        },
        true,
      );
      const finishBrowser = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(finishBrowser, undefined).pipe(
          Effect.andThen(Effect.sync(() => cancelCodexAuthCallback(authorizationUrl.toString()))),
        ),
      );
      const browserOpened = yield* Deferred.make<void>();
      const browserClosed = yield* Deferred.make<void>();
      const socketClosed = Promise.withResolvers<void>();
      let socket: NodeNet.Socket | undefined;
      yield* Effect.addFinalizer(() => Effect.sync(() => socket?.destroy()));
      const shell = ElectronShell.ElectronShell.of({
        openExternal: () =>
          Deferred.succeed(browserOpened, undefined).pipe(
            Effect.andThen(Deferred.await(finishBrowser)),
            Effect.as(true),
            Effect.ensuring(Deferred.succeed(browserClosed, undefined)),
          ),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;
        yield* Deferred.await(browserOpened);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              socket = NodeNet.connect(port, "127.0.0.1");
              socket.once("connect", resolve);
              socket.once("error", reject);
              socket.once("close", () => socketClosed.resolve());
            }),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell)),
        Effect.provideService(HostProcess.Arguments, ["t3", link]),
        Effect.provideService(ElectronApp.ElectronApp, {
          whenReady: Effect.void,
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(
          ElectronWindow.ElectronWindow,
          {} as ElectronWindow.ElectronWindow["Service"],
        ),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
      assert.isTrue(yield* Deferred.isDone(browserClosed));
      yield* Effect.promise(() => socketClosed.promise);
      yield* Effect.promise(async () => {
        const server = NodeHttp.createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
    }).pipe(Effect.scoped),
);

it.effect("serializes auth returns and avoids revealing a replaced window", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const firstStarted = yield* Deferred.make<void>();
    const finishFirst = Promise.withResolvers<void>();
    const inspectedBoth = Promise.withResolvers<void>();
    const loaded: string[] = [];
    const revealed: Electron.BrowserWindow[] = [];
    const first = {
      isDestroyed: () => false,
      loadURL: (url: string) => {
        loaded.push(`first:${url}`);
        Deferred.doneUnsafe(firstStarted, Effect.void);
        return finishFirst.promise;
      },
    } as unknown as Electron.BrowserWindow;
    const replacement = {
      isDestroyed: () => false,
      loadURL: async (url: string) => {
        loaded.push(`replacement:${url}`);
      },
    } as unknown as Electron.BrowserWindow;
    let current = first;
    let inspections = 0;
    const electronWindow = {
      waitForMain: Effect.sync(() => current),
      main: Effect.sync(() => {
        if (++inspections === 2) inspectedBoth.resolve();
        return Option.some(current);
      }),
      reveal: (window: Electron.BrowserWindow) =>
        Effect.sync(() => {
          revealed.push(window);
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      listeners.get("open-url")!({ preventDefault: () => {} }, "t3code-dev://app/welcome");
      yield* Deferred.await(firstStarted);
      listeners.get("open-url")!(
        { preventDefault: () => {} },
        "t3code-dev://app/settings/providers?instanceId=second",
      );
      assert.deepEqual(loaded, ["first:t3code-dev://app/welcome"]);
      current = replacement;
      finishFirst.resolve();
      yield* Effect.promise(() => inspectedBoth.promise);
      assert.deepEqual(loaded, [
        "first:t3code-dev://app/welcome",
        "replacement:t3code-dev://app/settings/providers?instanceId=second",
      ]);
      assert.deepEqual(revealed, [replacement]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, {} as ElectronApp.ElectronApp["Service"]),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  }),
);
