/**
 * `t3 env add` - register a remote environment into a saved-environment
 * catalog without going through a client's pairing dialog.
 *
 * `t3 project` exists because GUIs cannot add a project to a remote
 * environment; this exists for the mirror-image gap on the other side of
 * that same limitation: nothing headless can add an *environment* to a
 * saved-environment catalog. A server spun up by a provisioning pipeline has
 * no way to make itself appear in a fleet of already-installed clients
 * without a human opening a pairing dialog once per machine.
 *
 * This reuses the exact probe-and-bootstrap path clients call on pairing
 * (`preparePairingRegistration` from `@t3tools/client-runtime/connection`).
 * It intentionally does NOT touch the live `EnvironmentRegistry` /
 * `EnvironmentSupervisor` machinery a running client uses - that graph
 * exists to supervise a long-lived connection, which a one-shot CLI
 * invocation has no business standing up.
 *
 * ---
 *
 * Revised after review (thank you, Macroscope and Bugbot, both caught real
 * bugs in the first version):
 *
 * 1. The desktop app's actual catalog is `connection-catalog.json`
 *    (`DesktopConnectionCatalogStore`) - a single blob encrypted whole via
 *    Electron's `safeStorage` (OS keychain-backed). `saved-environments.json`
 *    (`DesktopSavedEnvironments`) is a *legacy* plaintext-ish format that
 *    only gets read once, to migrate into the encrypted catalog, and only
 *    when `connection-catalog.json` does not exist yet. Once a desktop app
 *    has launched and migrated, writing to `saved-environments.json` is a
 *    complete no-op - the first version of this command targeted exactly
 *    that file, unconditionally.
 *
 *    This command cannot safely write into an already-migrated encrypted
 *    catalog: doing that means either reproducing Electron's `safeStorage`
 *    (tied to the OS keychain and the desktop app's own identity - not
 *    something a headless Node process can reasonably replicate) or writing
 *    plaintext into a field the app expects to be encrypted. So it checks
 *    for a sibling `connection-catalog.json` first and refuses with an
 *    explicit error if one exists, rather than silently doing nothing or
 *    corrupting anything. It only ever writes the legacy format, which is
 *    only useful pre-first-launch (e.g. pre-seeding a brand new machine's
 *    catalog as part of provisioning, before the desktop app has ever run
 *    there) - a narrower claim than the original PR description made.
 *
 * 2. Round-tripping every existing record through
 *    `PersistedSavedEnvironmentRecordSchema` silently dropped any
 *    `encryptedBearerToken` (or other fields that schema doesn't know
 *    about) on *every other* record in the file, not just the one being
 *    added - a real, reported data-loss bug. Existing records are now
 *    carried through as opaque JSON objects and never decoded against a
 *    narrowing schema; only the new record being inserted is
 *    schema-validated. Whatever fields already live on other records -
 *    known to this file or not - survive untouched.
 *
 * 3. Read/write errors now carry an operation discriminator, matching
 *    `DesktopSavedEnvironmentsReadError` / `WriteError` /
 *    `DocumentDecodeError` conventions instead of collapsing every failure
 *    mode into one message.
 */
import { preparePairingRegistration } from "@t3tools/client-runtime/connection";
import * as ClientCapabilities from "@t3tools/client-runtime/platform";
import {
  AuthStandardClientScopes,
  type PersistedSavedEnvironmentRecord,
  PersistedSavedEnvironmentRecordSchema,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag, Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";

/**
 * An existing catalog record, kept as an opaque JSON object rather than
 * decoded against `PersistedSavedEnvironmentRecordSchema`. That schema is
 * the *contract* shape used to validate the one new record this command
 * writes - it is deliberately NOT used to parse records already in the
 * file, because doing so drops any field it doesn't know about
 * (`encryptedBearerToken` being the one that actually bit us in review).
 */
type OpaqueCatalogRecord = Readonly<Record<string, unknown>>;

interface CatalogDocument {
  readonly version: number;
  readonly records: readonly OpaqueCatalogRecord[];
}

const readEnvironmentId = (record: OpaqueCatalogRecord): string | undefined =>
  typeof record["environmentId"] === "string" ? (record["environmentId"] as string) : undefined;

const CatalogReadOperation = Schema.Literals(["read-file", "parse-json"]);
type CatalogReadOperation = typeof CatalogReadOperation.Type;

export class EnvCatalogReadError extends Schema.TaggedErrorClass<EnvCatalogReadError>()(
  "EnvCatalogReadError",
  { operation: CatalogReadOperation, path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the environment catalog during ${this.operation} at ${this.path}.`;
  }
}

const CatalogWriteOperation = Schema.Literals([
  "encode-catalog",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
]);
type CatalogWriteOperation = typeof CatalogWriteOperation.Type;

export class EnvCatalogWriteError extends Schema.TaggedErrorClass<EnvCatalogWriteError>()(
  "EnvCatalogWriteError",
  { operation: CatalogWriteOperation, path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write the environment catalog during ${this.operation} at ${this.path}.`;
  }
}

export class EnvCatalogEncryptedCatalogExistsError extends Schema.TaggedErrorClass<EnvCatalogEncryptedCatalogExistsError>()(
  "EnvCatalogEncryptedCatalogExistsError",
  { encryptedCatalogPath: Schema.String },
) {
  override get message(): string {
    return [
      `${this.encryptedCatalogPath} already exists.`,
      "That is the desktop app's real, current catalog - a single blob encrypted",
      "whole via Electron's safeStorage (OS keychain-backed). This command has no",
      "access to that, running outside Electron, so it cannot safely add to an",
      "already-migrated catalog without either reimplementing OS-keychain",
      "encryption or writing something the app can't read. It only supports",
      "pre-seeding a legacy-format catalog before a desktop app has ever launched",
      "on this machine (i.e. before that file exists). Pair through the desktop",
      "app's own dialog for an already-provisioned machine instead.",
    ].join(" ");
  }
}

export type EnvCatalogPreflightError = EnvCatalogReadError | EnvCatalogEncryptedCatalogExistsError;

/**
 * Refuses to proceed if the sibling encrypted catalog
 * (`connection-catalog.json`) already exists next to `catalogPath` - see
 * the module doc comment for why writing to the legacy file at that point
 * would be silently ignored by the desktop app, not merely unnecessary.
 */
export const assertLegacyCatalogIsSafeToWrite = Effect.fn("env.assertLegacyCatalogIsSafeToWrite")(
  function* (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path["Service"],
    catalogPath: string,
  ): Effect.fn.Return<void, EnvCatalogPreflightError> {
    const encryptedCatalogPath = path.join(path.dirname(catalogPath), "connection-catalog.json");
    const exists = yield* fileSystem.exists(encryptedCatalogPath).pipe(
      Effect.mapError(
        (cause) =>
          new EnvCatalogReadError({ operation: "read-file", path: encryptedCatalogPath, cause }),
      ),
    );
    if (exists) {
      return yield* new EnvCatalogEncryptedCatalogExistsError({ encryptedCatalogPath });
    }
  },
);

export const readCatalog = Effect.fn("env.readCatalog")(function* (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.fn.Return<CatalogDocument, EnvCatalogReadError> {
  const raw = yield* fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new EnvCatalogReadError({ operation: "read-file", path: catalogPath, cause: error }),
          ),
    ),
  );
  if (raw === null) {
    return { version: 1, records: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return yield* new EnvCatalogReadError({ operation: "parse-json", path: catalogPath, cause });
  }
  const document = parsed as { version?: number; records?: readonly OpaqueCatalogRecord[] };
  return {
    version: typeof document.version === "number" ? document.version : 1,
    records: Array.isArray(document.records) ? document.records : [],
  };
});

// Same atomic-write shape already used by the desktop app's own saved
// environments store: write to a sibling temp file, then rename over the
// real path, so a crash mid-write cannot leave a half-written catalog.
export const writeCatalog = Effect.fn("env.writeCatalog")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path["Service"],
  catalogPath: string,
  document: CatalogDocument,
): Effect.fn.Return<void, EnvCatalogWriteError> {
  const directory = path.dirname(catalogPath);
  const tempPath = `${catalogPath}.${process.pid}.tmp`;
  let encoded: string;
  try {
    encoded = JSON.stringify(document, null, 2);
  } catch (cause) {
    return yield* new EnvCatalogWriteError({
      operation: "encode-catalog",
      path: catalogPath,
      cause,
    });
  }
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) => new EnvCatalogWriteError({ operation: "create-directory", path: directory, cause }),
    ),
  );
  yield* fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new EnvCatalogWriteError({ operation: "write-temporary-file", path: tempPath, cause }),
    ),
  );
  yield* fileSystem.rename(tempPath, catalogPath).pipe(
    Effect.mapError(
      (cause) =>
        new EnvCatalogWriteError({ operation: "replace-catalog-file", path: catalogPath, cause }),
    ),
  );
});

/**
 * Replaces any existing record for the same environment rather than
 * appending a duplicate. Existing records are passed through opaque and
 * untouched - see the module doc comment for why this must not decode them
 * against a narrowing schema.
 */
export function upsertEnvironmentRecord(
  records: readonly OpaqueCatalogRecord[],
  nextRecord: PersistedSavedEnvironmentRecord,
): readonly OpaqueCatalogRecord[] {
  return [
    ...records.filter((record) => readEnvironmentId(record) !== nextRecord.environmentId),
    nextRecord as OpaqueCatalogRecord,
  ];
}

const cliClientPresentationLayer = Layer.succeed(ClientCapabilities.ClientPresentation, {
  metadata: { deviceType: "bot", label: "t3 env add" },
  scopes: AuthStandardClientScopes,
});

const pairingUrlArg = Flag.string("pairing-url").pipe(
  Flag.withDescription(
    "Full pairing URL, as printed by `t3 serve` or `t3 pair` (contains the token).",
  ),
  Flag.optional,
);

const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Server host, used together with --pairing-code instead of --pairing-url."),
  Flag.optional,
);

const pairingCodeFlag = Flag.string("pairing-code").pipe(
  Flag.withDescription("Pairing code, used together with --host instead of --pairing-url."),
  Flag.optional,
);

const catalogPathFlag = Flag.string("catalog-path").pipe(
  Flag.withDescription(
    "Path to the legacy-format catalog file to pre-seed. Defaults to " +
      "<base-dir>/userdata/saved-environments.json. Only safe to use before a desktop " +
      "app has ever launched on this machine - see --help on this command for why.",
  ),
  Flag.optional,
);

const printTokenFlag = Flag.boolean("print-token").pipe(
  Flag.withDescription(
    "Print the bootstrapped bearer token once. No token is persisted by this command: " +
      "the legacy catalog format this writes has no secret field of its own either.",
  ),
  Flag.withDefault(false),
);

const timeoutFlag = Flag.string("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("How long to wait for the environment to answer. Defaults to 10s."),
  Flag.optional,
);

export const envAddCommand = Command.make("add", {
  pairingUrl: pairingUrlArg,
  host: hostFlag,
  pairingCode: pairingCodeFlag,
  catalogPath: catalogPathFlag,
  printToken: printTokenFlag,
  timeout: timeoutFlag,
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Pre-seed a legacy-format saved-environment catalog, before a desktop app's first " +
      "launch on this machine. Refuses if the real (encrypted) catalog already exists - " +
      "see --help.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const registration = yield* preparePairingRegistration({
        ...(Option.isSome(flags.pairingUrl) ? { pairingUrl: flags.pairingUrl.value } : {}),
        ...(Option.isSome(flags.host) ? { host: flags.host.value } : {}),
        ...(Option.isSome(flags.pairingCode) ? { pairingCode: flags.pairingCode.value } : {}),
      }).pipe(
        Effect.provide(cliClientPresentationLayer),
        Effect.provide(FetchHttpClient.layer),
        Option.isSome(flags.timeout) ? Effect.timeout(flags.timeout.value) : (self) => self,
      );

      const catalogPath =
        Option.getOrNull(flags.catalogPath) ??
        (yield* Effect.gen(function* () {
          const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
          const derived = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});
          return path.join(derived.stateDir, "saved-environments.json");
        }));

      yield* assertLegacyCatalogIsSafeToWrite(fileSystem, path, catalogPath);

      const document = yield* readCatalog(fileSystem, catalogPath);
      const now = DateTime.formatIso(yield* DateTime.now);
      const nextRecord: PersistedSavedEnvironmentRecord = {
        environmentId: registration.target.environmentId,
        label: registration.target.label,
        httpBaseUrl: registration.profile.httpBaseUrl,
        wsBaseUrl: registration.profile.wsBaseUrl,
        createdAt: now,
        lastConnectedAt: null,
      };
      // Validate the shape of only the record we're adding - everything
      // else in the file stays untouched and undecoded (see above).
      yield* Schema.decodeUnknownEffect(PersistedSavedEnvironmentRecordSchema)(nextRecord);

      yield* writeCatalog(fileSystem, path, catalogPath, {
        version: document.version,
        records: upsertEnvironmentRecord(document.records, nextRecord),
      });

      yield* Console.log(
        [
          `Added ${nextRecord.label} (${nextRecord.environmentId}) to ${catalogPath}.`,
          `  http: ${nextRecord.httpBaseUrl}`,
          `  ws:   ${nextRecord.wsBaseUrl}`,
          "No bearer token was persisted. Pass --print-token if a caller needs it.",
        ].join("\n"),
      );

      if (flags.printToken) {
        yield* Console.log(`Token: ${registration.credential.token}`);
      }
    }),
  ),
);

export const envCommand = Command.make("env").pipe(
  Command.withDescription("Pre-seed a saved-environment catalog headlessly, before first launch."),
  Command.withSubcommands([envAddCommand]),
);
