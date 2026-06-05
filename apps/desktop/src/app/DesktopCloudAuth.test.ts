import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopCloudAuth from "./DesktopCloudAuth.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

interface CloudAuthHarness {
  readonly app: ElectronApp.ElectronAppShape;
  readonly window: ElectronWindow.ElectronWindowShape;
  readonly listeners: Map<string, readonly ((...args: readonly unknown[]) => void)[]>;
  readonly protocolRegistrations: {
    readonly protocol: string;
    readonly path?: string;
    readonly args?: readonly string[];
  }[];
  readonly sends: { readonly channel: string; readonly args: readonly unknown[] }[];
  readonly reveals: unknown[];
  readonly layer: Layer.Layer<
    | DesktopCloudAuth.DesktopCloudAuth
    | DesktopEnvironment.DesktopEnvironment
    | ElectronApp.ElectronApp
    | ElectronWindow.ElectronWindow
  >;
}

function makeHarness(input: { readonly isDevelopment: boolean }): CloudAuthHarness {
  const listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  const protocolRegistrations: CloudAuthHarness["protocolRegistrations"] = [];
  const sends: CloudAuthHarness["sends"] = [];
  const reveals: unknown[] = [];
  const mainWindow = { id: "main-window" };

  const app = ElectronApp.ElectronApp.of({
    metadata: Effect.succeed({
      appVersion: "0.0.0-test",
      appPath: "/tmp/t3-code-test",
      isPackaged: !input.isDevelopment,
      resourcesPath: "/tmp/t3-code-test/resources",
      runningUnderArm64Translation: false,
    }),
    name: Effect.succeed("T3 Code"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: (protocol, path, args) =>
      Effect.sync(() => {
        protocolRegistrations.push({
          protocol,
          ...(path === undefined ? {} : { path }),
          ...(args === undefined ? {} : { args }),
        });
        return true;
      }),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    on: (eventName, listener) =>
      Effect.sync(() => {
        const erasedListener = listener as (...args: readonly unknown[]) => void;
        listeners.set(eventName, [...(listeners.get(eventName) ?? []), erasedListener]);
      }),
  });

  const window = ElectronWindow.ElectronWindow.of({
    create: () => Effect.die("not used"),
    main: Effect.succeed(Option.some(mainWindow as never)),
    currentMainOrFirst: Effect.succeed(Option.some(mainWindow as never)),
    focusedMainOrFirst: Effect.succeed(Option.some(mainWindow as never)),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: (target) =>
      Effect.sync(() => {
        reveals.push(target);
      }),
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        sends.push({ channel, args });
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });

  const environment = DesktopEnvironment.DesktopEnvironment.of({
    isDevelopment: input.isDevelopment,
  } as DesktopEnvironment.DesktopEnvironmentShape);
  const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment);

  return {
    app,
    window,
    listeners,
    protocolRegistrations,
    sends,
    reveals,
    layer: Layer.mergeAll(
      DesktopCloudAuth.layer.pipe(
        Layer.provideMerge(environmentLayer),
        Layer.provide(NodeServices.layer),
      ),
      Layer.succeed(ElectronApp.ElectronApp, app),
      Layer.succeed(ElectronWindow.ElectronWindow, window),
    ),
  };
}

function emitAppEvent(
  harness: CloudAuthHarness,
  eventName: string,
  ...args: readonly unknown[]
): void {
  for (const listener of harness.listeners.get(eventName) ?? []) {
    listener(...args);
  }
}

const flushCloudAuthDispatch = Effect.promise(() => Promise.resolve());

describe("DesktopCloudAuth", () => {
  it("uses separate callback schemes for packaged and development builds", () => {
    assert.equal(
      DesktopCloudAuth.resolveCloudAuthCallbackScheme({ isDevelopment: false }),
      "t3code",
    );
    assert.equal(
      DesktopCloudAuth.resolveCloudAuthCallbackScheme({ isDevelopment: true }),
      "t3code-dev",
    );
  });

  it("builds a native callback URL with request state", () => {
    assert.equal(
      DesktopCloudAuth.buildCloudAuthCallbackUrl({
        scheme: "t3code",
        state: "state-1",
      }),
      "t3code://auth/callback?t3_state=state-1",
    );
  });

  it("accepts only the expected scheme, host, path, and state", () => {
    assert.isNotNull(
      DesktopCloudAuth.parseCloudAuthCallbackUrl({
        rawUrl: "t3code://auth/callback?rotating_token_nonce=nonce&t3_state=state-1",
        scheme: "t3code",
        state: "state-1",
      }),
    );
    assert.isNull(
      DesktopCloudAuth.parseCloudAuthCallbackUrl({
        rawUrl: "t3code://auth/callback?rotating_token_nonce=nonce&t3_state=wrong",
        scheme: "t3code",
        state: "state-1",
      }),
    );
    assert.isNull(
      DesktopCloudAuth.parseCloudAuthCallbackUrl({
        rawUrl: "https://example.com/callback?rotating_token_nonce=nonce&t3_state=state-1",
        scheme: "t3code",
        state: "state-1",
      }),
    );
  });

  it("builds a native development callback URL with request state", () => {
    assert.equal(
      DesktopCloudAuth.buildCloudAuthCallbackUrl({
        scheme: "t3code-dev",
        state: "state-1",
      }),
      "t3code-dev://auth/callback?t3_state=state-1",
    );
  });

  it.effect("registers the development protocol client and dispatches matching callbacks", () => {
    const harness = makeHarness({ isDevelopment: true });

    return Effect.gen(function* () {
      const cloudAuth = yield* DesktopCloudAuth.DesktopCloudAuth;
      yield* cloudAuth.configure;
      const redirectUrl = yield* cloudAuth.createRequest;
      const callbackUrl = new URL(redirectUrl);
      callbackUrl.searchParams.set("rotating_token_nonce", "nonce-1");

      let prevented = false;
      emitAppEvent(
        harness,
        "open-url",
        { preventDefault: () => (prevented = true) },
        callbackUrl.toString(),
      );
      yield* flushCloudAuthDispatch;

      assert.isTrue(prevented);
      assert.deepEqual(
        harness.protocolRegistrations.map((registration) => registration.protocol),
        ["t3code-dev"],
      );
      assert.isString(harness.protocolRegistrations[0]?.path);
      assert.isArray(harness.protocolRegistrations[0]?.args);
      assert.deepEqual(harness.sends, [
        {
          channel: IpcChannels.CLOUD_AUTH_CALLBACK_CHANNEL,
          args: [callbackUrl.toString()],
        },
      ]);
      assert.lengthOf(harness.reveals, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("rejects mismatched callback state and only consumes the pending request once", () => {
    const harness = makeHarness({ isDevelopment: false });

    return Effect.gen(function* () {
      const cloudAuth = yield* DesktopCloudAuth.DesktopCloudAuth;
      yield* cloudAuth.configure;
      const redirectUrl = yield* cloudAuth.createRequest;
      const validCallback = new URL(redirectUrl);
      validCallback.searchParams.set("rotating_token_nonce", "nonce-1");
      const invalidCallback = new URL(validCallback);
      invalidCallback.searchParams.set(DesktopCloudAuth.CLOUD_AUTH_CALLBACK_STATE_PARAM, "wrong");

      emitAppEvent(
        harness,
        "open-url",
        { preventDefault: () => undefined },
        invalidCallback.toString(),
      );
      yield* flushCloudAuthDispatch;
      assert.deepEqual(harness.sends, []);

      emitAppEvent(
        harness,
        "open-url",
        { preventDefault: () => undefined },
        validCallback.toString(),
      );
      yield* flushCloudAuthDispatch;
      emitAppEvent(
        harness,
        "open-url",
        { preventDefault: () => undefined },
        validCallback.toString(),
      );
      yield* flushCloudAuthDispatch;

      assert.deepEqual(
        harness.protocolRegistrations.map((registration) => registration.protocol),
        ["t3code"],
      );
      assert.deepEqual(harness.sends, [
        {
          channel: IpcChannels.CLOUD_AUTH_CALLBACK_CHANNEL,
          args: [validCallback.toString()],
        },
      ]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect(
    "routes second-instance callbacks and reveals the window for non-callback launches",
    () => {
      const harness = makeHarness({ isDevelopment: true });

      return Effect.gen(function* () {
        const cloudAuth = yield* DesktopCloudAuth.DesktopCloudAuth;
        yield* cloudAuth.configure;
        const redirectUrl = yield* cloudAuth.createRequest;
        const callbackUrl = new URL(redirectUrl);
        callbackUrl.searchParams.set("rotating_token_nonce", "nonce-1");

        emitAppEvent(harness, "second-instance", {}, ["electron", callbackUrl.toString()]);
        yield* flushCloudAuthDispatch;

        const revealCountAfterCallback = harness.reveals.length;
        emitAppEvent(harness, "second-instance", {}, ["electron", "--opened-from-dock"]);
        yield* flushCloudAuthDispatch;

        assert.deepEqual(harness.sends, [
          {
            channel: IpcChannels.CLOUD_AUTH_CALLBACK_CHANNEL,
            args: [callbackUrl.toString()],
          },
        ]);
        assert.equal(revealCountAfterCallback, 1);
        assert.equal(harness.reveals.length, 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    },
  );
});
