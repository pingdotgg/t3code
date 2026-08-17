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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as BrowserSession from "../BrowserSession.ts";
import { readChromiumCookies } from "./ChromiumCookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  cookieDatabasePath,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePaths,
  type BrowserImportSourceDefinition,
  type SourcePaths,
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

export class BrowserImport extends Context.Service<
  BrowserImport,
  {
    readonly listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>>;
    readonly importCookies: (input: {
      readonly input: BrowserImportInput;
      /** Partition scope of the target profile, derived by the caller in main. */
      readonly scope: string;
      readonly persistent: boolean;
    }) => Effect.Effect<BrowserImportResult, BrowserImportFailedError>;
  }
>()("@t3tools/desktop/preview/BrowserImport/BrowserImport") {}

const unavailableReason = Effect.fn("BrowserImport.unavailableReason")(function* (
  definition: BrowserImportSourceDefinition,
  platform: NodeJS.Platform,
  paths: SourcePaths,
): Effect.fn.Return<BrowserImportUnavailableReason | undefined, never, FileSystem.FileSystem> {
  if (!definition.platforms.includes(platform)) return "unsupportedPlatform";
  if (!(yield* isSourceInstalled(definition, paths))) return "notInstalled";
  if (yield* isSourceRunning(definition, paths)) return "browserRunning";
  return undefined;
});

export const make = Effect.gen(function* BrowserImportMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const platform = yield* HostProcessPlatform;
  const executablePath = yield* HostProcessExecutablePath;
  // Captured here so the service's methods stay free of a requirements
  // channel: the layer is built where NodeServices is already in scope.
  const platformServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const paths = yield* sourcePaths;

  const listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>> = Effect.forEach(
    BROWSER_IMPORT_SOURCES,
    Effect.fnUntraced(function* (definition) {
      const unavailable = yield* unavailableReason(definition, platform, paths);
      return {
        id: definition.id,
        name: definition.name,
        // Listing profiles touches the source's own files, so skip it when the
        // source is unusable anyway.
        profiles: unavailable === undefined ? yield* listSourceProfiles(definition, paths) : [],
        ...(unavailable === undefined ? {} : { unavailable }),
      } satisfies BrowserImportSource;
    }),
  ).pipe(Effect.provide(platformServices));

  const importCookies = Effect.fn("BrowserImport.importCookies")(function* (input: {
    readonly input: BrowserImportInput;
    readonly scope: string;
    readonly persistent: boolean;
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

    const blocked = yield* unavailableReason(definition, platform, paths).pipe(
      Effect.provide(platformServices),
    );
    if (blocked !== undefined) {
      return yield* new BrowserImportFailedError({ sourceId: definition.id, reason: blocked });
    }

    // macOS attributes the Keychain prompt and the resulting ACL grant to the
    // executable that asks, so record which one that was — in a packaged build
    // it is the signed app, in dev whatever binary hosts the main process.
    yield* Effect.logInfo("Reading browser cookie key from the keychain", {
      sourceId: definition.id,
      executablePath,
    });

    // The profile directory arrives over IPC, so it is only honoured when the
    // source itself reported it. Forwarding it unchecked would let `..`
    // segments walk out of the browser's user-data directory and read any
    // cookie database reachable on disk.
    const sourceProfiles = yield* listSourceProfiles(definition, paths).pipe(
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

    const cookies = yield* readChromiumCookies({
      cookieDatabasePath: cookieDatabasePath(definition, paths, requestedProfile.directory),
      keychainService: definition.keychainService,
      keychainAccount: definition.keychainAccount,
      platform,
    }).pipe(
      Effect.scoped,
      Effect.provide(platformServices),
      Effect.mapError(
        (cause) =>
          new BrowserImportFailedError({ sourceId: definition.id, reason: cause.reason, cause }),
      ),
    );

    const session = yield* browserSession.getSession(input.scope, input.persistent).pipe(
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
    let imported = 0;
    let skipped = 0;
    for (const cookie of cookies) {
      const written = yield* Effect.tryPromise({
        try: () =>
          session.cookies.set({
            url: cookie.url,
            name: cookie.name,
            value: cookie.value,
            // Omitted for host-only cookies: Electron reads any `domain` as a
            // domain cookie and re-adds the leading dot, which would widen the
            // scope of every host-only cookie the source had.
            ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            ...(cookie.expirationDate === undefined
              ? {}
              : { expirationDate: cookie.expirationDate }),
          }),
        catch: () => undefined,
      }).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
      if (written) imported += 1;
      else skipped += 1;
    }

    return { imported, skipped };
  });

  return BrowserImport.of({ listSources, importCookies });
});

export const layer = Layer.effect(BrowserImport, make);
