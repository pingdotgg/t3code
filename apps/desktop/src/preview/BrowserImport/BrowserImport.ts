/**
 * Browser import service - lists importable sources and writes their cookies
 * into a T3 Code browser profile's Electron partition.
 *
 * @module BrowserImport
 */
import type {
  BrowserImportInput,
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportUnavailableReason,
} from "@t3tools/contracts";
import { BrowserImportFailureReason } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as BrowserSession from "../BrowserSession.ts";
import { ChromiumCookieReadError, readChromiumCookies } from "./ChromiumCookies.ts";
import type { CookieReadResult } from "./CookieDatabase.ts";
import { FirefoxCookieReadError, readFirefoxCookies } from "./FirefoxCookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  resolveCookieDatabase,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePathContext,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "./Sources.ts";

export class BrowserImportFailedError extends Schema.TaggedErrorClass<BrowserImportFailedError>()(
  "BrowserImportFailedError",
  {
    sourceId: Schema.String,
    reason: BrowserImportFailureReason,
    /** Kept for the log; the user only ever sees the reason's copy. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The reason token is part of the message on purpose: IPC flattens the error
  // to its message, and the renderer maps that token back to user-facing copy.
  override get message(): string {
    return `Importing cookies from ${this.sourceId} failed: ${this.reason}.`;
  }
}

export class BrowserCookieWriteError extends Schema.TaggedErrorClass<BrowserCookieWriteError>()(
  "BrowserCookieWriteError",
  {
    url: Schema.String,
    name: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not write imported cookie ${this.name} for ${this.url}.`;
  }
}

export class BrowserImport extends Context.Service<
  BrowserImport,
  {
    readonly listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>>;
    readonly importCookies: (input: {
      readonly input: BrowserImportInput;
      /** Partition scope of the target profile, derived by the caller in main. */
      readonly scope: string;
      readonly persistent: boolean;
      readonly namespace?: BrowserSession.BrowserSessionPartitionNamespace;
    }) => Effect.Effect<BrowserImportResult, BrowserImportFailedError>;
  }
>()("@t3tools/desktop/preview/BrowserImport/BrowserImport") {}

const unavailableReason = Effect.fn("BrowserImport.unavailableReason")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<
  BrowserImportUnavailableReason | undefined,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  if (!definition.platforms.includes(context.platform)) return "unsupportedPlatform";
  if (!(yield* isSourceInstalled(definition, context))) return "notInstalled";
  if (yield* isSourceRunning(definition, context)) return "browserRunning";
  return undefined;
});

/** The host a constructed cookie URL points at, for naming what was skipped. */
const cookieHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export const writeCookies = Effect.fn("BrowserImport.writeCookies")(function* (
  session: { readonly cookies: Pick<Session["cookies"], "set" | "flushStore"> },
  read: CookieReadResult,
) {
  let imported = 0;
  let skipped = read.undecryptable;
  const skippedDomains = new Set(read.undecryptableHosts);
  for (const cookie of read.cookies) {
    const written = yield* Effect.tryPromise({
      try: () =>
        session.cookies.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          // Omitted for host-only cookies: Electron reads any `domain` as a
          // domain cookie and re-adds the leading dot, widening its scope.
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        }),
      catch: (cause) => new BrowserCookieWriteError({ url: cookie.url, name: cookie.name, cause }),
    }).pipe(
      Effect.as(true),
      Effect.tapError((error) => Effect.logDebug(error.message, { cause: error.cause })),
      Effect.catchTags({ BrowserCookieWriteError: () => Effect.succeed(false) }),
    );
    if (written) {
      imported += 1;
    } else {
      skipped += 1;
      skippedDomains.add(cookieHost(cookie.url));
    }
  }
  // `set` resolves once the cookie is in memory; Chromium writes the store to
  // disk on its own schedule. Flush before reporting "Done", so a crash right
  // after does not lose what the user was just told was imported. A failed
  // flush is logged rather than surfaced: the cookies are still in the
  // session and land on disk at the next scheduled write.
  if (imported > 0) {
    yield* Effect.tryPromise(() => session.cookies.flushStore()).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Imported cookies could not be flushed to disk", { cause: error.cause }),
      ),
      Effect.ignore,
    );
  }
  return { imported, skipped, skippedDomains: [...skippedDomains].slice(0, 20) };
});

export const make = Effect.gen(function* BrowserImportMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const platform = yield* HostProcessPlatform;
  const executablePath = yield* HostProcessExecutablePath;
  // Captured here so the service's methods stay free of a requirements
  // channel: the layer is built where NodeServices is already in scope.
  const platformServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const pathContext = yield* sourcePathContext;

  const listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>> = Effect.forEach(
    BROWSER_IMPORT_SOURCES,
    Effect.fnUntraced(function* (definition) {
      const unavailable = yield* unavailableReason(definition, pathContext);
      return {
        id: definition.id,
        name: definition.name,
        // Listing profiles touches the source's own files, so skip it when the
        // source is unusable anyway.
        profiles:
          unavailable === undefined ? yield* listSourceProfiles(definition, pathContext) : [],
        ...(unavailable === undefined ? {} : { unavailable }),
      } satisfies BrowserImportSource;
    }),
  ).pipe(Effect.provide(platformServices));

  const importCookies = Effect.fn("BrowserImport.importCookies")(function* (input: {
    readonly input: BrowserImportInput;
    readonly scope: string;
    readonly persistent: boolean;
    readonly namespace?: BrowserSession.BrowserSessionPartitionNamespace;
  }) {
    const definition = BROWSER_IMPORT_SOURCES.find(
      (candidate) => candidate.id === input.input.sourceId,
    );
    if (!definition) {
      return yield* new BrowserImportFailedError({
        sourceId: input.input.sourceId,
        reason: "unknownSource",
      });
    }

    const blocked = yield* unavailableReason(definition, pathContext).pipe(
      Effect.provide(platformServices),
    );
    if (blocked !== undefined) {
      return yield* new BrowserImportFailedError({ sourceId: definition.id, reason: blocked });
    }

    if (platform === "darwin" && definition.engine === "chromium") {
      // macOS attributes the Keychain prompt and the resulting ACL grant to the
      // executable that asks, so record which one that was — in a packaged build
      // it is the signed app, in dev whatever binary hosts the main process.
      yield* Effect.logInfo("Reading browser cookie key from the keychain", {
        sourceId: definition.id,
        executablePath,
      });
    }

    // The profile directory arrives over IPC, so it is only honoured when the
    // source itself reported it. Forwarding it unchecked would let `..`
    // segments walk out of the browser's user-data directory and read any
    // cookie database reachable on disk.
    const sourceProfiles = yield* listSourceProfiles(definition, pathContext).pipe(
      Effect.provide(platformServices),
    );
    const requestedProfile = sourceProfiles.find(
      (profile) => profile.directory === input.input.sourceProfileDirectory,
    );
    if (requestedProfile === undefined) {
      return yield* new BrowserImportFailedError({
        sourceId: definition.id,
        reason: "unknownSourceProfile",
      });
    }

    // The profile was listed against a database moments ago; resolve it again
    // rather than assume a path, since a Chromium jar may sit under `Network/`.
    const databasePath = yield* resolveCookieDatabase(
      definition,
      pathContext,
      requestedProfile.directory,
    ).pipe(Effect.provide(platformServices));
    if (databasePath === undefined) {
      // A profile we listed moments ago can lose its database before the
      // import runs (browser data cleanup, a profile reset). That is a read
      // failure, not a platform problem.
      return yield* new BrowserImportFailedError({ sourceId: definition.id, reason: "readFailed" });
    }

    // Both branches fail with a tagged error, so the union stays structurally
    // identifiable and each tag is handled on its own below. The success side
    // is normalized to one shape too, so the skipped tally survives either
    // engine — Firefox stores plaintext, so nothing there is ever unreadable.
    const userDataDirectory = definition.userDataDirectory(pathContext);
    const read: Effect.Effect<
      CookieReadResult,
      ChromiumCookieReadError | FirefoxCookieReadError,
      FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
    > =
      definition.engine === "firefox"
        ? readFirefoxCookies(databasePath).pipe(
            Effect.map((cookies) => ({ cookies, undecryptable: 0, undecryptableHosts: [] })),
          )
        : readChromiumCookies({
            cookieDatabasePath: databasePath,
            keychainService: definition.keychainService,
            keychainAccount: definition.keychainAccount,
            linuxSecretApplication: definition.linuxSecretApplication,
            ...(platform === "win32" && userDataDirectory !== undefined
              ? {
                  windowsLocalStatePath: pathContext.path.join(userDataDirectory, "Local State"),
                }
              : {}),
            platform,
          });

    const result = yield* read.pipe(
      Effect.scoped,
      Effect.provide(platformServices),
      Effect.catchTags({
        ChromiumCookieReadError: (cause) =>
          Effect.fail(
            new BrowserImportFailedError({ sourceId: definition.id, reason: cause.reason, cause }),
          ),
        // Firefox has one failure mode — its plaintext database would not open
        // — so its error carries no reason of its own and the user-facing one
        // is supplied here.
        FirefoxCookieReadError: (cause) =>
          Effect.fail(
            new BrowserImportFailedError({ sourceId: definition.id, reason: "readFailed", cause }),
          ),
      }),
    );

    const session = yield* browserSession
      .getSession(input.scope, input.persistent, input.namespace)
      .pipe(
        Effect.mapError(
          (cause) =>
            new BrowserImportFailedError({
              sourceId: definition.id,
              reason: "sessionUnavailable",
              cause,
            }),
        ),
      );

    // Written one at a time rather than in parallel: Chromium's cookie store
    // serialises writes anyway, and a rejected cookie should only cost itself.
    return yield* writeCookies(session, result);
  });

  return BrowserImport.of({ listSources, importCookies });
});

export const layer = Layer.effect(BrowserImport, make);
