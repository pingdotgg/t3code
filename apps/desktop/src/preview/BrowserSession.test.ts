import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("electron", () => ({
  session: {
    fromPartition,
  },
}));

import * as BrowserSession from "./BrowserSession.ts";

const layer = BrowserSession.layer.pipe(Layer.provide(NodeServices.layer));

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
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
        "notifications",
        "geolocation",
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
      for (const permission of ["clipboard-write", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves partition scope and the platform failure chain", () => {
    const nativeCause = new Error("native digest failed");
    const platformCause = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "digest",
      cause: nativeCause,
    });
    const failingCryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(platformCause),
      }),
    );

    return Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const error = yield* browserSessions.getPartition("environment-a").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionPartitionDerivationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-a");
      assert.strictEqual(error.cause, platformCause);
      assert.strictEqual(error.cause.reason.cause, nativeCause);
      assert.equal(
        error.message,
        "Failed to derive a desktop preview browser partition for scope environment-a.",
      );
      assert.notInclude(error.message, nativeCause.message);
    }).pipe(Effect.provide(BrowserSession.layer.pipe(Layer.provide(failingCryptoLayer))));
  });

  it.effect("preserves session scope, partition, and the Electron failure", () =>
    Effect.gen(function* () {
      const cause = new Error("Electron session failed");
      fromPartition.mockImplementationOnce(() => {
        throw cause;
      });
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("environment-b");
      const error = yield* browserSessions.getSession("environment-b").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionCreationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-b");
      assert.equal(error.partition, partition);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to create a desktop preview browser session for scope environment-b (partition ${partition}).`,
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears storage and cache for every created session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");

      yield* browserSessions.clearCookies();
      yield* browserSessions.clearCache();

      assert.strictEqual(sessions.size, 2);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
        assert.deepEqual(browserSession.clearStorageData.mock.calls[0], [
          {
            storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
          },
        ]);
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("correlates clear failures while still attempting every session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");
      const firstPartition = yield* browserSessions.getPartition("scope-a");
      const secondPartition = yield* browserSessions.getPartition("scope-b");
      const firstSession = sessions.get(firstPartition);
      const secondSession = sessions.get(secondPartition);
      assert.isDefined(firstSession);
      assert.isDefined(secondSession);

      const storageCause = new Error("storage clear failed");
      secondSession.clearStorageData.mockImplementationOnce(() => Promise.reject(storageCause));
      const storageError = yield* browserSessions.clearCookies().pipe(Effect.flip);

      assert.instanceOf(storageError, BrowserSession.BrowserSessionStorageClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(storageError));
      assert.equal(storageError.partition, secondPartition);
      assert.strictEqual(storageError.cause, storageCause);
      assert.equal(
        storageError.message,
        `Failed to clear desktop preview browser storage for partition ${secondPartition}.`,
      );
      assert.notInclude(storageError.message, storageCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
      }

      const cacheCause = new Error("cache clear failed");
      firstSession.clearCache.mockImplementationOnce(() => Promise.reject(cacheCause));
      const cacheError = yield* browserSessions.clearCache().pipe(Effect.flip);

      assert.instanceOf(cacheError, BrowserSession.BrowserSessionCacheClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(cacheError));
      assert.equal(cacheError.partition, firstPartition);
      assert.strictEqual(cacheError.cause, cacheCause);
      assert.equal(
        cacheError.message,
        `Failed to clear the desktop preview browser cache for partition ${firstPartition}.`,
      );
      assert.notInclude(cacheError.message, cacheCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});
