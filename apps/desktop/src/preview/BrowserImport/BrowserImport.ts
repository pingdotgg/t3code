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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as BrowserSession from "../BrowserSession.ts";
import {
  ChromiumCookieReadError,
  readChromiumCookies,
  type ChromiumCookie,
} from "./ChromiumCookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  cookieDatabasePath,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  type BrowserImportSourceDefinition,
} from "./Sources.ts";

export class BrowserImportFailedError extends Schema.TaggedErrorClass<BrowserImportFailedError>()(
  "BrowserImportFailedError",
  {
    sourceId: Schema.String,
    reason: Schema.String,
  },
) {
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

const unavailableReason = async (
  definition: BrowserImportSourceDefinition,
  platform: NodeJS.Platform,
): Promise<BrowserImportUnavailableReason | undefined> => {
  if (!definition.platforms.includes(platform)) return "unsupportedPlatform";
  if (!(await isSourceInstalled(definition))) return "notInstalled";
  if (await isSourceRunning(definition)) return "browserRunning";
  return undefined;
};

export const make = Effect.gen(function* BrowserImportMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const platform = yield* HostProcessPlatform;
  const executablePath = yield* HostProcessExecutablePath;

  const listSources = Effect.promise(async (): Promise<ReadonlyArray<BrowserImportSource>> => {
    const sources: BrowserImportSource[] = [];
    for (const definition of BROWSER_IMPORT_SOURCES) {
      const unavailable = await unavailableReason(definition, platform);
      sources.push({
        id: definition.id,
        name: definition.name,
        // Listing profiles touches the source's own files, so skip it when the
        // source is unusable anyway.
        profiles: unavailable === undefined ? await listSourceProfiles(definition) : [],
        ...(unavailable === undefined ? {} : { unavailable }),
      });
    }
    return sources;
  });

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
        reason: "unknown source",
      });
    }

    const blocked = yield* Effect.promise(() => unavailableReason(definition, platform));
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

    const cookies: ReadonlyArray<ChromiumCookie> = yield* Effect.tryPromise({
      try: () =>
        readChromiumCookies({
          cookieDatabasePath: cookieDatabasePath(definition, input.input.sourceProfileDirectory),
          keychainService: definition.keychainService,
          keychainAccount: definition.keychainAccount,
          platform,
        }),
      catch: (cause) =>
        new BrowserImportFailedError({
          sourceId: definition.id,
          reason: cause instanceof ChromiumCookieReadError ? cause.failure.reason : "readFailed",
        }),
    });

    const session = yield* browserSession
      .getSession(input.scope, input.persistent)
      .pipe(
        Effect.mapError(
          () => new BrowserImportFailedError({ sourceId: definition.id, reason: "readFailed" }),
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
            domain: cookie.domain,
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
