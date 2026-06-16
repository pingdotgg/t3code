import type { Session } from "electron";
import { session } from "electron";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";

export class BrowserSessionError extends Data.TaggedError("BrowserSessionError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Desktop preview browser session operation failed: ${this.operation}`;
  }
}

export interface BrowserSessionShape {
  readonly getPartition: (scope?: string) => Effect.Effect<string, BrowserSessionError>;
  readonly isPartition: (partition: string) => boolean;
  readonly getSession: (scope?: string) => Effect.Effect<Session, BrowserSessionError>;
  readonly clearCookies: () => Effect.Effect<void, BrowserSessionError>;
  readonly clearCache: () => Effect.Effect<void, BrowserSessionError>;
}

export class BrowserSession extends Context.Service<BrowserSession, BrowserSessionShape>()(
  "@t3tools/desktop/preview/BrowserSession",
) {}

const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Crypto.Crypto;
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (scope = "shared") {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(scope))
      .pipe(
        Effect.mapError((cause) => new BrowserSessionError({ operation: "getPartition", cause })),
      );
    return `${PREVIEW_PARTITION_PREFIX}${Encoding.encodeHex(digest).slice(0, 20)}`;
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (scope = "shared") {
    const partition = yield* getPartition(scope);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          const userAgent = browserSession
            .getUserAgent()
            .replace(/Electron\/[\d.]+ /, "")
            .replace(/\s*t3code\/[\d.]+/, "");
          browserSession.setUserAgent(userAgent);
          browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
            const allowed = ["clipboard-read", "clipboard-write", "notifications", "geolocation"];
            callback(allowed.includes(permission));
          });
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) => new BrowserSessionError({ operation: "getSession", cause }),
      });
    });
  });

  return BrowserSession.of({
    getPartition,
    isPartition: (partition) => partition.startsWith(PREVIEW_PARTITION_PREFIX),
    getSession,
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.values()].map((browserSession) =>
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
              }),
            catch: (cause) => new BrowserSessionError({ operation: "clearCookies", cause }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.values()].map((browserSession) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) => new BrowserSessionError({ operation: "clearCache", cause }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effect(BrowserSession, make);
