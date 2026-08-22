import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore, openDatabase } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

describe("openDatabase", () => {
  it.effect("fails instead of hanging when another tab blocks the version change", () =>
    Effect.gen(function* () {
      const request = new EventTarget();
      vi.stubGlobal("indexedDB", {
        open: vi.fn(() => {
          queueMicrotask(() => request.dispatchEvent(new Event("blocked")));
          return request;
        }),
      });

      const error = yield* openDatabase().pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("close the other T3 Code tabs");
    }),
  );

  it.effect("closes the database when the blocked open later succeeds", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const request = Object.assign(new EventTarget(), { result: { close } });
      vi.stubGlobal("indexedDB", {
        open: vi.fn(() => {
          queueMicrotask(() => request.dispatchEvent(new Event("blocked")));
          return request;
        }),
      });

      yield* openDatabase().pipe(Effect.flip);
      // The blocking tab closes and the request completes after we already
      // failed; nothing will take ownership of the handle, so it must not leak.
      request.dispatchEvent(new Event("success"));

      expect(close).toHaveBeenCalledTimes(1);
    }),
  );
});
