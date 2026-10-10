import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  configureWebAuthn: vi.fn(),
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn(),
}));
const webauthn = vi.hoisted(() => ({ createCredential: vi.fn(), getCredential: vi.fn() }));

vi.mock("electron", () => ({
  app: { configureWebAuthn: electron.configureWebAuthn },
  dialog: { showMessageBox: electron.showMessageBox },
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  webContents: { fromFrame: () => undefined },
}));
vi.mock("electron-webauthn", () => webauthn);

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { PASSKEY_CREATE_CHANNEL, PASSKEY_GET_CHANNEL } from "./GuestProtocol.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

const layerFor = (packageJson: object, isPackaged = true) =>
  PreviewPasskeys.layer.pipe(
    Layer.provide(
      Layer.succeed(
        DesktopEnvironment.DesktopEnvironment,
        DesktopEnvironment.DesktopEnvironment.of({
          platform: "darwin",
          isPackaged,
          appRoot: "/app",
          path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
    ),
    Layer.provide(
      FileSystem.layerNoop({
        readFileString: () => Effect.succeed(JSON.stringify(packageJson)),
      }),
    ),
  );

type Handler = (event: { readonly senderFrame: object | null }, publicKey: unknown) => unknown;

const makeGuest = (origin = "https://accounts.example.com") => {
  const handlers = new Map<string, Handler>();
  const state = { focused: true };
  const mainFrame = { origin, isDestroyed: () => false };
  const guest = {
    mainFrame,
    hostWebContents: {},
    isFocused: () => state.focused,
    ipc: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
  };
  const call = (channel: string, publicKey: unknown, senderFrame: object | null = mainFrame) =>
    Effect.promise(async () => handlers.get(channel)?.({ senderFrame }, publicKey));
  return { guest: guest as unknown as Electron.WebContents, mainFrame, handlers, state, call };
};

const bridgeLayer = layerFor({ t3codeWebAuthn: { browserPasskeys: true } });

/** CBOR `{ fmt: "packed", attStmt: { alg: -7, sig }, authData }`, as authenticators encode it. */
const attestationObject = (authData: ReadonlyArray<number>) => {
  const text = (value: string) => [0x60 + value.length, ...Buffer.from(value)];
  const bytes = (value: ReadonlyArray<number>) => [0x58, value.length, ...value];
  return Buffer.from([
    0xa3,
    ...text("fmt"),
    ...text("packed"),
    ...text("attStmt"),
    0xa2,
    ...text("alg"),
    0x26,
    ...text("sig"),
    ...bytes(Array.from({ length: 70 }, () => 7)),
    ...text("authData"),
    ...bytes(authData),
  ]).toString("base64url");
};

describe("PreviewPasskeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.fromWebContents.mockReturnValue({
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.from([1]),
    });
  });
  // Restored here so a failing fake-timer test cannot leak fake timers into the next one.
  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect("pins each guest ceremony to the origin of the frame that asked", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const { guest, handlers, call } = makeGuest();
      webauthn.getCredential.mockResolvedValue({
        success: false,
        error: "NotAllowedError",
        errorObject: new Error("native detail"),
      });

      const detach = passkeys.attachGuest(guest);
      const publicKey = { challenge: new Uint8Array([1]), rpId: "example.com" };
      const result = yield* call(PASSKEY_GET_CHANNEL, publicKey);

      assert.deepStrictEqual(result, { success: false, error: "NotAllowedError" });
      const [sentPublicKey, options] = webauthn.getCredential.mock.calls[0] ?? [];
      assert.deepStrictEqual(sentPublicKey, publicKey);
      assert.strictEqual(options.currentOrigin, "https://accounts.example.com");
      assert.strictEqual(options.topFrameOrigin, "https://accounts.example.com");
      assert.isTrue(options.isPublicSuffix("com"));
      assert.isTrue(options.isPublicSuffix("github.io"));
      assert.isFalse(options.isPublicSuffix("example.com"));
      assert.isFalse(options.isPublicSuffix("localhost"));

      // WebAuthn defaults the RP ID to the caller's own host.
      yield* call(PASSKEY_GET_CHANNEL, { challenge: new Uint8Array([1]) });
      assert.strictEqual(webauthn.getCredential.mock.calls[1]?.[0].rpId, "accounts.example.com");

      // Only the main frame runs the preload; anything else is not the page.
      const forged = yield* call(PASSKEY_CREATE_CHANNEL, publicKey, {
        origin: "https://evil.example",
      });
      assert.deepStrictEqual(forged, { success: false, error: "NotAllowedError" });
      assert.strictEqual(webauthn.createCredential.mock.calls.length, 0);

      detach();
      assert.strictEqual(handlers.size, 0);
    }).pipe(Effect.provide(bridgeLayer)),
  );

  it.effect("registers ES256 keys only and reports their real authenticator data", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const { guest, call } = makeGuest();
      passkeys.attachGuest(guest);
      webauthn.createCredential.mockResolvedValue({
        success: true,
        data: {
          credentialId: "AQ",
          clientDataJSON: "Ag",
          attestationObject: attestationObject([1, 2, 3, 4]),
          authData: Buffer.from('{"parsed":true}').toString("base64url"),
          publicKey: "BQ",
          publicKeyAlgorithm: -7,
          transports: ["hybrid", "internal"],
          extensions: {},
        },
      });
      const publicKey = {
        challenge: new Uint8Array([1]),
        pubKeyCredParams: [
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
      };

      const result = yield* call(PASSKEY_CREATE_CHANNEL, publicKey);

      assert.deepStrictEqual(webauthn.createCredential.mock.calls[0]?.[0].pubKeyCredParams, [
        { type: "public-key", alg: -7 },
      ]);
      assert.deepInclude(result, { success: true });
      const data = (result as { readonly data: Record<string, unknown> }).data;
      assert.strictEqual(data.authData, Buffer.from([1, 2, 3, 4]).toString("base64url"));
      assert.deepStrictEqual(data.transports, []);

      const unsupported = yield* call(PASSKEY_CREATE_CHANNEL, {
        ...publicKey,
        pubKeyCredParams: [{ type: "public-key", alg: -8 }],
      });
      assert.deepStrictEqual(unsupported, { success: false, error: "NotSupportedError" });
      assert.strictEqual(webauthn.createCredential.mock.calls.length, 1);

      // A malformed algorithm list is the page's error, not a cue to pick ES256.
      const malformed = yield* call(PASSKEY_CREATE_CHANNEL, {
        ...publicKey,
        pubKeyCredParams: { type: "public-key", alg: -7 },
      });
      assert.deepStrictEqual(malformed, { success: false, error: "TypeError" });
      assert.strictEqual(webauthn.createCredential.mock.calls.length, 1);

      // Without authenticator data the site cannot verify the passkey.
      webauthn.createCredential.mockResolvedValueOnce({
        success: true,
        data: { credentialId: "AQ", attestationObject: Buffer.from([0x00]).toString("base64url") },
      });
      assert.deepStrictEqual(yield* call(PASSKEY_CREATE_CHANNEL, publicKey), {
        success: false,
        error: "NotAllowedError",
      });
    }).pipe(Effect.provide(bridgeLayer)),
  );

  it.effect("answers only with a credential the site allowed", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const { guest, call } = makeGuest();
      passkeys.attachGuest(guest);
      const assertion = (credentialId: string) => ({
        success: true,
        data: {
          credentialId,
          clientDataJSON: "Ag",
          authenticatorData: "Aw",
          signature: "BA",
          userHandle: "BQ",
        },
      });
      const publicKey = {
        challenge: new Uint8Array([1]),
        rpId: "example.com",
        allowCredentials: [{ type: "public-key", id: new Uint8Array([1]) }],
      };

      // macOS applies the allow list to passkeys but not to security keys.
      webauthn.getCredential.mockResolvedValueOnce(assertion("Ag"));
      const other = yield* call(PASSKEY_GET_CHANNEL, publicKey);
      assert.deepStrictEqual(other, { success: false, error: "NotAllowedError" });

      webauthn.getCredential.mockResolvedValueOnce(assertion("AQ"));
      assert.deepInclude(yield* call(PASSKEY_GET_CHANNEL, publicKey), { success: true });

      // With no allow list, any of the site's credentials will do.
      webauthn.getCredential.mockResolvedValueOnce(assertion("Ag"));
      const discoverable = yield* call(PASSKEY_GET_CHANNEL, {
        challenge: new Uint8Array([1]),
        rpId: "example.com",
      });
      assert.deepInclude(discoverable, { success: true });
    }).pipe(Effect.provide(bridgeLayer)),
  );

  it.effect("opens the sheet only for a focused, secure page with nothing else pending", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const notAllowed = { success: false, error: "NotAllowedError" };
      const publicKey = { challenge: new Uint8Array([1]), rpId: "example.com" };

      const lan = makeGuest("http://192.168.1.5:3000");
      passkeys.attachGuest(lan.guest);
      assert.deepStrictEqual(yield* lan.call(PASSKEY_GET_CHANNEL, publicKey), notAllowed);
      // macOS refuses `*.localhost`, so the page hears no rather than a native error.
      const subdomain = makeGuest("http://app.localhost:3000");
      passkeys.attachGuest(subdomain.guest);
      assert.deepStrictEqual(yield* subdomain.call(PASSKEY_GET_CHANNEL, publicKey), notAllowed);

      const page = makeGuest();
      passkeys.attachGuest(page.guest);
      page.state.focused = false;
      assert.deepStrictEqual(yield* page.call(PASSKEY_GET_CHANNEL, publicKey), notAllowed);
      assert.strictEqual(webauthn.getCredential.mock.calls.length, 0);

      page.state.focused = true;
      let finish: (value: unknown) => void = () => {};
      webauthn.getCredential.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const first = yield* Effect.forkChild(page.call(PASSKEY_GET_CHANNEL, publicKey));
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      assert.deepStrictEqual(yield* page.call(PASSKEY_GET_CHANNEL, publicKey), notAllowed);

      // The page navigated while the sheet was up; its credential goes nowhere.
      page.mainFrame.origin = "https://other.example";
      finish({ success: true, data: { credentialId: "AQ" } });
      assert.deepStrictEqual(yield* Fiber.join(first), notAllowed);
    }).pipe(Effect.provide(bridgeLayer)),
  );

  it.effect("answers the page even when the native ceremony never settles", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const { guest, call } = makeGuest();
      passkeys.attachGuest(guest);
      webauthn.getCredential.mockReturnValueOnce(new Promise(() => {}));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = yield* Effect.forkChild(
        call(PASSKEY_GET_CHANNEL, { challenge: new Uint8Array([1]), timeout: 1_000 }),
      );
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));

      assert.deepStrictEqual(yield* Fiber.join(pending), {
        success: false,
        error: "NotAllowedError",
      });
    }).pipe(Effect.provide(bridgeLayer)),
  );

  it.effect("turns each path on only for builds signed for it", () =>
    Effect.gen(function* () {
      const entitled = yield* PreviewPasskeys.PreviewPasskeys.pipe(
        Effect.provide(
          layerFor({
            t3codeWebAuthn: {
              touchIdKeychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn",
              browserPasskeys: false,
            },
          }),
        ),
      );
      yield* entitled.configure;
      assert.deepStrictEqual(electron.configureWebAuthn.mock.calls, [
        [{ touchID: { keychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn" } }],
      ]);
      assert.isFalse(entitled.bridgeEnabled);
      const { guest, handlers } = makeGuest();
      entitled.attachGuest(guest);
      assert.strictEqual(handlers.size, 0);

      const unpackaged = yield* PreviewPasskeys.PreviewPasskeys.pipe(
        Effect.provide(
          layerFor(
            { t3codeWebAuthn: { touchIdKeychainAccessGroup: "X", browserPasskeys: true } },
            false,
          ),
        ),
      );
      yield* unpackaged.configure;
      assert.strictEqual(electron.configureWebAuthn.mock.calls.length, 1);
      assert.isFalse(unpackaged.bridgeEnabled);
    }),
  );

  it.effect("asks which passkey to use only when a site has several", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const listeners: Array<(...args: ReadonlyArray<unknown>) => void> = [];
      const session = {
        on: (_event: string, listener: (...args: ReadonlyArray<unknown>) => void) =>
          listeners.push(listener),
      } as unknown as Electron.Session;
      passkeys.installSessionHandlers(session);
      passkeys.installSessionHandlers(session);
      assert.strictEqual(listeners.length, 1);

      const select = (accounts: ReadonlyArray<Electron.WebAuthnAccount>) =>
        Effect.promise(
          () =>
            new Promise<unknown>((resolve) =>
              listeners[0]?.(
                {},
                { relyingPartyId: "example.com", accounts, frame: null },
                (credentialId?: string) => resolve(credentialId),
              ),
            ),
        );
      const alice = { credentialId: "alice", name: "alice@example.com" };
      const bob = { credentialId: "bob", displayName: "Bob", name: "bob@example.com" };

      assert.strictEqual(yield* select([alice]), "alice");
      assert.strictEqual(electron.showMessageBox.mock.calls.length, 0);

      electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
      assert.strictEqual(yield* select([alice, bob]), "bob");
      assert.deepStrictEqual(electron.showMessageBox.mock.calls[0]?.[0]?.buttons, [
        "alice@example.com",
        "Bob (bob@example.com)",
        "Cancel",
      ]);

      electron.showMessageBox.mockResolvedValueOnce({ response: 2 });
      assert.isUndefined(yield* select([alice, bob]));
    }).pipe(Effect.provide(layerFor({}))),
  );
});
