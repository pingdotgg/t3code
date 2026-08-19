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
 * (`preparePairingRegistration` from `@t3tools/client-runtime/connection`)
 * and persists the result using the same `PersistedSavedEnvironmentRecord`
 * shape the desktop app reads from disk on launch. It intentionally does
 * NOT touch the live `EnvironmentRegistry` / `EnvironmentSupervisor`
 * machinery a running client uses - that graph exists to supervise a
 * long-lived connection, which a one-shot CLI invocation has no business
 * standing up. A client picks up the new entry the next time it reads its
 * own catalog file (normally on launch).
 *
 * Secrets are handled conservatively: by default no bearer token is
 * persisted, matching the shape of `PersistedSavedEnvironmentRecord` itself,
 * which has no secret field - only the desktop app's own storage layer adds
 * one (`encryptedBearerToken`, encrypted at rest via Electron's
 * `safeStorage`), and this command has no access to that. Pass
 * `--print-token` to have the bootstrapped bearer token printed once so a
 * provisioning script can store it wherever it already stores other
 * secrets, instead of this command inventing a second, unencrypted place
 * for it to live on disk.
 *
 * Path assumption worth double-checking before relying on this in
 * automation: the default catalog path is derived from the same
 * `--base-dir` / `T3CODE_HOME` convention the server CLI already uses
 * elsewhere (`ServerConfig.deriveServerPaths`), on the assumption that it
 * lines up with the desktop app's own state directory on the same machine.
 * That has not been verified against every desktop build; pass
 * `--catalog-path` explicitly if you are not sure, and compare against
 * whatever `DesktopEnvironment`'s `savedEnvironmentRegistryPath` resolves to
 * for your install.
 */
import { preparePairingRegistration } from "@t3tools/client-runtime/connection";
import * as ClientCapabilities from "@t3tools/client-runtime/platform";
import {
  AuthStandardClientScopes,
  type PersistedSavedEnvironmentRecord,
  PersistedSavedEnvironmentRecordSchema,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
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

const CatalogDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(PersistedSavedEnvironmentRecordSchema)),
});
type CatalogDocument = { readonly version: number; readonly records: readonly PersistedSavedEnvironmentRecord[] };

const CatalogDocumentJson = fromLenientJson(CatalogDocumentSchema);
const decodeCatalogDocumentJson = Schema.decodeEffect(CatalogDocumentJson);
const encodeCatalogDocumentJson = Schema.encodeEffect(CatalogDocumentJson);

export class EnvCatalogWriteError extends Schema.TaggedErrorClass<EnvCatalogWriteError>()(
  "EnvCatalogWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write the environment catalog at ${this.path}.`;
  }
}

export class EnvCatalogReadError extends Schema.TaggedErrorClass<EnvCatalogReadError>()(
  "EnvCatalogReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the environment catalog at ${this.path}.`;
  }
}

export const readCatalog = Effect.fn("env.readCatalog")(function* (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.fn.Return<CatalogDocument, EnvCatalogReadError> {
  const raw = yield* fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(new EnvCatalogReadError({ path: catalogPath, cause: error })),
    ),
  );
  if (raw === null) {
    return { version: 1, records: [] };
  }
  const decoded = yield* decodeCatalogDocumentJson(raw).pipe(
    Effect.mapError((cause) => new EnvCatalogReadError({ path: catalogPath, cause })),
  );
  return { version: decoded.version ?? 1, records: decoded.records ?? [] };
});

// Same shape of atomic write already used by the desktop app's saved
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
  const encoded = yield* encodeCatalogDocumentJson(document).pipe(
    Effect.mapError((cause) => new EnvCatalogWriteError({ path: catalogPath, cause })),
  );
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError((cause) => new EnvCatalogWriteError({ path: catalogPath, cause })),
  );
  yield* fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError((cause) => new EnvCatalogWriteError({ path: catalogPath, cause })),
  );
  yield* fileSystem.rename(tempPath, catalogPath).pipe(
    Effect.mapError((cause) => new EnvCatalogWriteError({ path: catalogPath, cause })),
  );
});

/** Replaces any existing record for the same environment rather than appending a duplicate. */
export function upsertEnvironmentRecord(
  records: readonly PersistedSavedEnvironmentRecord[],
  nextRecord: PersistedSavedEnvironmentRecord,
): readonly PersistedSavedEnvironmentRecord[] {
  return [
    ...records.filter((record) => record.environmentId !== nextRecord.environmentId),
    nextRecord,
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
    "Path to the saved-environment catalog file. Defaults to <base-dir>/userdata/saved-environments.json - " +
      "verify this matches your desktop install's own path before relying on it in automation.",
  ),
  Flag.optional,
);

const printTokenFlag = Flag.boolean("print-token").pipe(
  Flag.withDescription(
    "Print the bootstrapped bearer token once. No token is persisted by this command otherwise: " +
      "PersistedSavedEnvironmentRecord has no secret field, so store it yourself if you need it.",
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
    "Register a remote environment into a saved-environment catalog without a pairing dialog.",
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
  Command.withDescription("Manage the saved-environment catalog headlessly."),
  Command.withSubcommands([envAddCommand]),
);
