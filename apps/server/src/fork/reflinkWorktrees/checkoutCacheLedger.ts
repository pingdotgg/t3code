// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger names need a random suffix.
import * as NodeCrypto from "node:crypto";

import type * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { inRootCacheDir } from "./checkoutCacheSites.ts";

/** A cache folder the ledger holds, so a later run finds it again. Only the ledger makes one. */
export type RecordedFolder = string & Brand.Brand<"RecordedFolder">;

const LedgerFile = Schema.Struct({
  version: Schema.Literal(1),
  home: Schema.Boolean,
  inRoot: Schema.Array(Schema.String),
});
type Ledger = Omit<typeof LedgerFile.Type, "version">;
const decodeLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerFile));
const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(LedgerFile));
const FILE_NAME = "worktree-checkout-caches.json";

/**
 * The cache folders one T3 state dir has used, recorded before anything is written there:
 * whether it used the T3 home's cache, and the real locations whose reserved folder it used.
 * Paths come from this run's key and home cache folder, so a copied ledger never names another
 * home's folder. Append-only, and called only under the sites module's lock.
 */
export const makeCheckoutCacheLedger = Effect.fn("CheckoutCacheLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly key: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(input.stateDir, FILE_NAME);
  const empty: Ledger = { home: false, inRoot: [] };
  // A crash between creating a temporary ledger and renaming it leaves the temporary behind.
  for (const name of yield* fileSystem
    .readDirectory(input.stateDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
    if (name.startsWith(`${FILE_NAME}.tmp-`)) {
      yield* fileSystem.remove(path.join(input.stateDir, name)).pipe(Effect.ignore);
    }
  }
  let ledger: Ledger = yield* fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodeLedger),
    Effect.map(({ home, inRoot }) => ({
      home,
      inRoot: inRoot.filter((root) => path.isAbsolute(root) && path.resolve(root) === root),
    })),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed(empty)
        : Effect.logWarning("Ignoring an unreadable checkout cache ledger", { file, error }).pipe(
            Effect.as(empty),
          ),
    ),
  );

  // Durable before any cache write: a crash leaves the old ledger or the new one, never neither.
  const write = Effect.fn("CheckoutCacheLedger.write")(
    function* (next: Ledger) {
      const contents = new TextEncoder().encode(yield* encodeLedger({ version: 1, ...next }));
      const temporary = `${file}.tmp-${NodeCrypto.randomUUID()}`;
      yield* Effect.scoped(
        Effect.flatMap(fileSystem.open(temporary, { flag: "wx" }), (handle) =>
          Effect.andThen(handle.writeAll(contents), handle.sync),
        ),
      ).pipe(Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
      yield* fileSystem.rename(temporary, file);
      yield* Effect.scoped(Effect.flatMap(fileSystem.open(input.stateDir), (dir) => dir.sync));
      ledger = next;
      return true;
    },
    Effect.catch((error) =>
      Effect.logWarning("Could not record a checkout cache folder", { file, error }).pipe(
        Effect.as(false),
      ),
    ),
    Effect.uninterruptible,
  );

  const mint = (folder: string) => folder as RecordedFolder;

  return {
    /** The recorded folders, and the real locations they are in, for this run's home cache folder. */
    entries: (homeCacheDir: string) =>
      Effect.sync(() => ({
        roots: ledger.inRoot,
        folders: [
          ...(ledger.home ? [homeCacheDir] : []),
          ...ledger.inRoot.map((root) => inRootCacheDir(root, input.key, path)),
        ].map(mint),
      })),
    /** Undefined when the ledger could not be written, and then nothing may be written there. */
    record: Effect.fn("CheckoutCacheLedger.record")(function* (
      site: { readonly root: string } | { readonly home: string },
    ) {
      const next =
        "home" in site
          ? { ...ledger, home: true }
          : { ...ledger, inRoot: [...new Set([...ledger.inRoot, site.root])] };
      const unchanged = next.home === ledger.home && next.inRoot.length === ledger.inRoot.length;
      if (!unchanged && !(yield* write(next))) return undefined;
      return mint("home" in site ? site.home : inRootCacheDir(site.root, input.key, path));
    }),
  };
});
