import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly closeAllConnections: ReturnType<typeof vi.fn>;
      readonly storagePath: string | null;
      readonly getUserAgent: ReturnType<typeof vi.fn<() => string>>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
    }
  >(),
}));

const storage = vi.hoisted(() => ({ root: "" }));

const { fromWebContents } = vi.hoisted(() => ({
  fromWebContents: vi.fn<(webContents: unknown) => unknown>(() => null),
}));

const { appListeners } = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("electron", () => ({
  app: {
    on: (eventName: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(eventName, listener);
    },
    removeListener: (eventName: string) => {
      appListeners.delete(eventName);
    },
  },
  BrowserWindow: { fromWebContents },
  session: {
    fromPartition,
  },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as BrowserSession from "./BrowserSession.ts";

const { showMessageBox, showErrorBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn<
    (
      options: Electron.MessageBoxOptions,
      owner?: Electron.BrowserWindow,
    ) => number | Promise<number>
  >(() => 1),
  showErrorBox: vi.fn<(title: string, content: string) => void>(),
}));
const layerDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.die("unused"),
  pickFiles: () => Effect.die("unused"),
  showMessageBox: (options, owner) =>
    Effect.promise(async () => ({
      response: await showMessageBox(options, owner),
      checkboxChecked: false,
    })),
  showErrorBox: (title, content) => Effect.sync(() => showErrorBox(title, content)),
});
const layer = BrowserSession.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, layerDialog, ElectronApp.layer)),
);

const selfSignedCertificate = {
  fingerprint: "sha256/self-signed",
  subjectName: "localhost",
  issuerName: "localhost",
  validStart: 1_735_776_000,
  validExpiry: 1_807_056_000,
} as Electron.Certificate;

/** Raises Electron's `certificate-error` for a preview guest in `browserSession`. */
const certificateError = (
  browserSession: unknown,
  input: {
    readonly url: string;
    readonly certificate?: Electron.Certificate;
    readonly isMainFrame?: boolean;
  },
) => {
  const listener = appListeners.get("certificate-error");
  assert.isDefined(listener, "preview sessions should handle certificate errors");
  const guest = { session: browserSession, hostWebContents: null, isDestroyed: () => false };
  const event = { preventDefault: vi.fn() };
  const decision = Deferred.makeUnsafe<boolean>();
  const callback = vi.fn((trusted: boolean) => {
    Deferred.doneUnsafe(decision, Effect.succeed(trusted));
  });
  listener(
    event,
    guest,
    input.url,
    "net::ERR_CERT_AUTHORITY_INVALID",
    input.certificate ?? selfSignedCertificate,
    callback,
    input.isMainFrame ?? true,
  );
  return { event, callback, trusted: Deferred.await(decision) };
};

/** Answers the certificate prompt with its "Trust…" button. */
const trustCertificateButton = (options: Electron.MessageBoxOptions): number => {
  const index = (options.buttons ?? []).findIndex((label) => label.startsWith("Trust"));
  assert.notStrictEqual(index, -1, "the certificate prompt should offer to trust");
  return index;
};

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    appListeners.clear();
    storage.root = "";
    showErrorBox.mockReset();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        closeAllConnections: vi.fn(() => Promise.resolve()),
        // Like Electron, only a `persist:` partition has storage on disk.
        storagePath:
          storage.root !== "" && partition.startsWith("persist:")
            ? `${storage.root}/Partitions/${partition}`
            : null,
        getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setUserAgent: vi.fn(),
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:t3code-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps scopes that differ only by a lone surrogate in separate partitions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      // TextEncoder folds a lone surrogate to U+FFFD, so without escaping these
      // two supported ids would hash to one partition and share every cookie.
      const loneSurrogate = yield* browserSessions.getPartition("p\ud800");
      const replacementChar = yield* browserSessions.getPartition("p\ufffd");
      assert.notStrictEqual(loneSurrogate, replacementChar);

      const literal = yield* browserSessions.getPartition("p\\ud800");
      assert.notStrictEqual(literal, loneSurrogate);

      assert.strictEqual(
        yield* browserSessions.getPartition("scope-a"),
        "persist:t3code-preview-f051bb2c68cb7b2fe969",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps legacy defaults disjoint from nondefault profile partitions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const legacyDefault = yield* browserSessions.getPartition("a::b");
      const nondefaultProfile = yield* browserSessions.getPartition("a::b", true, "profile");

      assert.strictEqual(legacyDefault, "persist:t3code-preview-78f0be89237d77f7a70e");
      assert.strictEqual(nondefaultProfile, "persist:t3code-preview-profile-78f0be89237d77f7a70e");
      assert.notStrictEqual(nondefaultProfile, legacyDefault);
      assert.isTrue(browserSessions.isPartition(legacyDefault));
      assert.isTrue(browserSessions.isPartition(nondefaultProfile));
    }).pipe(Effect.provide(layer)),
  );

  // A rewritten session UA — any variant, even ones that keep the Electron
  // token — makes Cloudflare Turnstile loop with error 600010 (#5002), so the
  // guest must end up with Electron's native User-Agent.
  it.effect("keeps the guest's effective User-Agent equal to Electron's native one", () =>
    Effect.gen(function* () {
      // Electron's real UA shape: app token, then Chrome, then Electron, then
      // Safari — the token order and casing matter to any strip regex.
      const nativeUserAgent =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Alpha)/0.0.33 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36";
      fromPartition.mockReset();
      fromPartition.mockImplementation((partition: string) => {
        let userAgent = nativeUserAgent;
        const browserSession = {
          clearCache: vi.fn(() => Promise.resolve()),
          clearStorageData: vi.fn(() => Promise.resolve()),
          closeAllConnections: vi.fn(() => Promise.resolve()),
          storagePath: null,
          getUserAgent: vi.fn(() => userAgent),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setUserAgent: vi.fn((next: string) => {
            userAgent = next;
          }),
        };
        sessions.set(partition, browserSession);
        return browserSession;
      });

      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      assert.strictEqual(browserSession.getUserAgent(), nativeUserAgent);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("grants clipboard-sanitized-write through both the request and check handlers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);

      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "geolocation",
        "fullscreen",
      ]) {
        assert.isTrue(requestAllows(permission), `request handler should allow ${permission}`);
        assert.isTrue(
          checkHandler(null, permission) as boolean,
          `check handler should allow ${permission}`,
        );
      }

      // `clipboard-write` is not a real Electron permission — the async write API
      // uses `clipboard-sanitized-write` — so the stale name must not be granted,
      // and unrelated permissions stay denied.
      for (const permission of ["clipboard-write", "notifications", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("opens custom-scheme links externally only after the user confirms", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);

      const request = (externalURL: string) =>
        Effect.callback<boolean>((resume) => {
          requestHandler(
            null,
            "openExternal",
            (granted: boolean) => resume(Effect.succeed(granted)),
            { externalURL },
          );
        });

      showMessageBox.mockReset();
      showMessageBox.mockReturnValueOnce(0).mockReturnValueOnce(1);
      assert.isTrue(yield* request("slack://open?team=T1"));
      assert.isFalse(yield* request("zoommtg://zoom.us/join"));
      assert.strictEqual(showMessageBox.mock.calls.length, 2);

      for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
        assert.isFalse(yield* request(url), `${url} must never open externally`);
      }
      assert.strictEqual(showMessageBox.mock.calls.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears a partition whose session has not been opened yet", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-untouched");

      assert.isUndefined(sessions.get(partition));
      yield* browserSessions.clearCookies([partition]);
      assert.isUndefined(sessions.get(partition));

      yield* browserSessions.getSession("scope-untouched");
      yield* browserSessions.clearCookies([partition]);

      const created = sessions.get(partition);
      assert.isDefined(created);
      assert.strictEqual(created.clearStorageData.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks before trusting an untrusted certificate and remembers the approval", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);

      showMessageBox.mockReset();
      showMessageBox.mockImplementation(trustCertificateButton);
      const first = certificateError(browserSession, { url: "https://localhost:18443/" });
      assert.strictEqual(first.event.preventDefault.mock.calls.length, 1);
      assert.isTrue(yield* first.trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);

      // The approval covers this origin, port, and certificate in this profile.
      const again = certificateError(browserSession, { url: "https://localhost:18443/other" });
      assert.isTrue(yield* again.trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);
      // Its sockets reach the same TLS endpoint, and cannot ask on their own.
      const socket = certificateError(browserSession, {
        url: "wss://localhost:18443/hmr",
        isMainFrame: false,
      });
      assert.isTrue(yield* socket.trusted);
      const otherSocket = certificateError(browserSession, {
        url: "wss://localhost:18444/hmr",
        isMainFrame: false,
      });
      assert.isFalse(yield* otherSocket.trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);

      showMessageBox.mockReset();
      showMessageBox.mockReturnValue(1);
      const otherPort = certificateError(browserSession, { url: "https://localhost:18444/" });
      assert.isFalse(yield* otherPort.trusted);
      const renewed = certificateError(browserSession, {
        url: "https://localhost:18443/",
        certificate: { ...selfSignedCertificate, fingerprint: "sha256/renewed" },
      });
      assert.isFalse(yield* renewed.trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 2);

      // A Session that is not a preview profile keeps Electron's denial.
      const appSession = certificateError({}, { url: "https://localhost:18443/" });
      assert.strictEqual(appSession.event.preventDefault.mock.calls.length, 0);
      assert.strictEqual(appSession.callback.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("revokes certificate approvals when cookies are cleared, not the cache", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);
      const url = "https://localhost:18443/";

      showMessageBox.mockReset();
      showMessageBox.mockImplementation(trustCertificateButton);
      assert.isTrue(yield* certificateError(browserSession, { url }).trusted);

      yield* browserSessions.clearCache([partition]);
      assert.isTrue(yield* certificateError(browserSession, { url }).trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);

      yield* browserSessions.clearCookies([partition]);
      showMessageBox.mockReset();
      showMessageBox.mockReturnValue(1);
      assert.isFalse(yield* certificateError(browserSession, { url }).trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("remembers approvals across restarts, but not incognito ones", () =>
    Effect.gen(function* () {
      storage.root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const url = "https://localhost:18443/";
      const approve = Effect.gen(function* () {
        const browserSessions = yield* BrowserSession.BrowserSession;
        const persistent = yield* browserSessions.getPartition("scope-a");
        const incognito = yield* browserSessions.getPartition("scope-a", false);
        yield* browserSessions.getSession("scope-a");
        yield* browserSessions.getSession("scope-a", false);
        showMessageBox.mockReset();
        showMessageBox.mockImplementation(trustCertificateButton);
        assert.isTrue(yield* certificateError(sessions.get(persistent), { url }).trusted);
        assert.isTrue(yield* certificateError(sessions.get(incognito), { url }).trusted);
        return { persistent, incognito };
      });
      const { persistent, incognito } = yield* approve.pipe(Effect.provide(layer));

      // A restarted app gets fresh Session objects and reads approvals from disk.
      sessions.clear();
      appListeners.clear();
      yield* Effect.gen(function* () {
        const browserSessions = yield* BrowserSession.BrowserSession;
        yield* browserSessions.getSession("scope-a");
        yield* browserSessions.getSession("scope-a", false);
        showMessageBox.mockReset();
        showMessageBox.mockReturnValue(1);
        assert.isTrue(yield* certificateError(sessions.get(persistent), { url }).trusted);
        assert.strictEqual(showMessageBox.mock.calls.length, 0);
        assert.isFalse(yield* certificateError(sessions.get(incognito), { url }).trusted);
        assert.strictEqual(showMessageBox.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("an answer to a prompt opened before cookies were cleared does not trust", () =>
    Effect.gen(function* () {
      storage.root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);
      const url = "https://localhost:18443/";

      const asked = yield* Deferred.make<void>();
      let answer = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      showMessageBox.mockReset();
      showMessageBox.mockImplementation((options) => {
        Deferred.doneUnsafe(asked, Effect.void);
        return answered.then(() => trustCertificateButton(options));
      });
      const pending = certificateError(browserSession, { url });
      yield* Deferred.await(asked);
      yield* browserSessions.clearCookies([partition]);
      answer();
      assert.isFalse(yield* pending.trusted);

      showMessageBox.mockReset();
      showMessageBox.mockReturnValue(1);
      assert.isFalse(yield* certificateError(browserSession, { url }).trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);
      assert.isFalse(
        yield* (yield* FileSystem.FileSystem).exists(
          `${browserSession!.storagePath}/t3code-certificate-approvals.json`,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeServices.layer))),
  );

  it.effect("does not trust a certificate whose approval cannot be saved", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // A file where the profile directory should be makes every write fail.
      const root = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${root}/Partitions`, "");
      storage.root = root;
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);
      const url = "https://localhost:18443/";

      showMessageBox.mockReset();
      showMessageBox.mockImplementation(trustCertificateButton);
      assert.isFalse(yield* certificateError(browserSession, { url }).trusted);
      assert.strictEqual(showErrorBox.mock.calls.length, 1);
      // Nothing was trusted for this run either, so the next visit asks again.
      showMessageBox.mockReset();
      showMessageBox.mockReturnValue(1);
      assert.isFalse(yield* certificateError(browserSession, { url }).trusted);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeServices.layer))),
  );

  it.effect("clearing cookies deletes a saved approval even when none are loaded", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      storage.root = yield* fileSystem.makeTempDirectoryScoped();
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);
      // What a clear whose removal failed leaves behind: memory forgot, the file did not.
      const file = `${browserSession!.storagePath}/t3code-certificate-approvals.json`;
      yield* fileSystem.makeDirectory(browserSession!.storagePath!, { recursive: true });
      yield* fileSystem.writeFileString(
        file,
        JSON.stringify([
          {
            origin: "https://localhost:18443",
            fingerprint: selfSignedCertificate.fingerprint,
            error: "net::ERR_CERT_AUTHORITY_INVALID",
          },
        ]),
      );

      yield* browserSessions.clearCookies([partition]);
      assert.isFalse(yield* fileSystem.exists(file));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeServices.layer))),
  );
});
