import type { Session } from "electron";
import { session } from "electron";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  readonly getPartition: (scope?: string) => string;
  readonly isPartition: (partition: string) => boolean;
  readonly getSession: (scope?: string) => Effect.Effect<Session, BrowserSessionError>;
  readonly clearCookies: () => Effect.Effect<void, BrowserSessionError>;
  readonly clearCache: () => Effect.Effect<void, BrowserSessionError>;
}

export class BrowserSession extends Context.Service<BrowserSession, BrowserSessionShape>()(
  "@t3tools/desktop/preview/BrowserSession",
) {}

const make = Effect.fn("BrowserSession.make")(() =>
  Effect.sync(() => {
    const sessions = new Map<string, Session>();
    const getPartition = (scope = "shared"): string => {
      const digest = createHash("sha256").update(scope).digest("hex").slice(0, 20);
      return `${PREVIEW_PARTITION_PREFIX}${digest}`;
    };

    const getSession = Effect.fn("BrowserSession.getSession")(function* (scope = "shared") {
      const partition = getPartition(scope);
      const existing = sessions.get(partition);
      if (existing) return existing;
      return yield* Effect.try({
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
          sessions.set(partition, browserSession);
          return browserSession;
        },
        catch: (cause) => new BrowserSessionError({ operation: "getSession", cause }),
      });
    });

    return BrowserSession.of({
      getPartition,
      isPartition: (partition) => partition.startsWith(PREVIEW_PARTITION_PREFIX),
      getSession,
      clearCookies: Effect.fn("BrowserSession.clearCookies")(function* () {
        yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              [...sessions.values()].map((browserSession) =>
                browserSession.clearStorageData({
                  storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
                }),
              ),
            ),
          catch: (cause) => new BrowserSessionError({ operation: "clearCookies", cause }),
        });
      }),
      clearCache: Effect.fn("BrowserSession.clearCache")(function* () {
        yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              [...sessions.values()].map((browserSession) => browserSession.clearCache()),
            ),
          catch: (cause) => new BrowserSessionError({ operation: "clearCache", cause }),
        });
      }),
    });
  }),
);

export const layer = Layer.effect(BrowserSession, make());
