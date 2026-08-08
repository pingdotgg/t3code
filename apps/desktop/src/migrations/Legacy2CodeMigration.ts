import {
  decodeLegacy2CodeImportManifestJson,
  encodeLegacy2CodeImportManifestJson,
  type Legacy2CodeImportManifest,
  type Legacy2CodeImportProject,
  type Legacy2CodeImportThread,
  type Legacy2CodeClaudeCodexRouting,
} from "@t3tools/shared/fork/legacy2codeImport";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const MIGRATION_DIRECTORY_NAME = "legacy-2code-electron-v1";
export const LEGACY_2CODE_IMPORT_MANIFEST_NAME = "import.json";
const LEGACY_WORKSPACE_SNAPSHOT_NAME = "workspace.snapshot.json";
const LEGACY_WORKSPACE_BACKUP_SNAPSHOT_NAME = "workspace.backup.snapshot.json";
const LEGACY_CODEX_AUTH_BACKUP_DIRECTORY_NAME = "codex-auth.snapshot";
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("legacy-2code-migration");

const LegacyMigrationOperation = Schema.Literals([
  "create-private-directory",
  "read-source",
  "read-snapshot",
  "write-snapshot",
  "decode-workspace",
  "hash-snapshot",
  "read-manifest",
  "write-manifest",
  "read-codex-auth",
  "write-codex-auth-backup",
  "write-codex-auth-target",
]);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class Legacy2CodeMigrationError extends Schema.TaggedErrorClass<Legacy2CodeMigrationError>()(
  "Legacy2CodeMigrationError",
  {
    operation: LegacyMigrationOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Legacy 2code migration failed during ${this.operation} at "${this.path}".`;
  }
}

export type Legacy2CodeAuthMigrationStatus =
  | "not-found"
  | "no-valid-credentials"
  | "copied"
  | "already-present"
  | "failed";

export interface Legacy2CodeMigrationResult {
  readonly workspaceStatus: "not-found" | "prepared" | "already-prepared" | "failed";
  readonly authStatus: Legacy2CodeAuthMigrationStatus;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly skippedSessionCount: number;
}

interface LegacyWorkspaceProjection {
  readonly projects: ReadonlyArray<Legacy2CodeImportProject>;
  readonly threads: ReadonlyArray<Legacy2CodeImportThread>;
  readonly claudeCodexRouting?: Legacy2CodeClaudeCodexRouting;
  readonly skippedSessions: number;
}

interface LegacyWorkspaceSnapshot {
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly contents: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const trimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const legacyRoute = (value: unknown): Legacy2CodeImportThread["legacyRoute"] | undefined => {
  if (value === "anthropic" || value === "hybrid") return value;
  if (value === "codex-via-claude" || value === "native-codex") return value;
  return undefined;
};

const isoFromNonNegativeEpochMillis = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );
};

const normalizeLegacyWorkspace = (value: unknown, path: Path.Path): LegacyWorkspaceProjection => {
  if (!isRecord(value) || !isRecord(value.workspace)) {
    throw new Error("Stored workspace payload is missing.");
  }

  const rawProjects = Array.isArray(value.workspace.projects) ? value.workspace.projects : [];
  const projects: Array<Legacy2CodeImportProject> = [];
  const projectPaths = new Set<string>();
  for (const candidate of rawProjects) {
    if (!isRecord(candidate)) continue;
    const legacyPath = trimmedString(candidate.path);
    if (legacyPath === undefined || !path.isAbsolute(legacyPath)) continue;
    const normalizedPath = path.resolve(legacyPath);
    if (projectPaths.has(normalizedPath)) continue;
    const explicitTitle = trimmedString(candidate.name);
    const title = explicitTitle ?? path.basename(normalizedPath).trim();
    if (title.length === 0) continue;
    projectPaths.add(normalizedPath);
    projects.push({ legacyPath: normalizedPath, title });
  }

  const rawTabs = Array.isArray(value.workspace.openTabs) ? value.workspace.openTabs : [];
  const threads: Array<Legacy2CodeImportThread> = [];
  const resumeKeys = new Set<string>();
  let skippedSessions = 0;
  for (const candidate of rawTabs) {
    if (!isRecord(candidate)) {
      skippedSessions += 1;
      continue;
    }
    const mode = candidate.mode;
    const sessionId = trimmedString(candidate.sessionId);
    const legacyId = trimmedString(candidate.id);
    const rawProjectPath = trimmedString(candidate.projectPath);
    const title = trimmedString(candidate.title);
    if (
      mode !== "chat" ||
      candidate.chatEphemeral === true ||
      candidate.chatBackground === true ||
      sessionId === undefined ||
      legacyId === undefined ||
      rawProjectPath === undefined ||
      !path.isAbsolute(rawProjectPath) ||
      title === undefined
    ) {
      skippedSessions += 1;
      continue;
    }
    const projectPath = path.resolve(rawProjectPath);
    if (!projectPaths.has(projectPath)) {
      skippedSessions += 1;
      continue;
    }

    const executionProfile = isRecord(candidate.chatExecutionProfile)
      ? candidate.chatExecutionProfile
      : undefined;
    const route = legacyRoute(executionProfile?.route);
    const provider =
      route === "native-codex"
        ? "codex"
        : route === "codex-via-claude" || route === "hybrid" || route === "anthropic"
          ? "claude"
          : candidate.backend === "codex"
            ? "codex"
            : "claude";
    const resumeKey = `${provider}:${sessionId}`;
    if (resumeKeys.has(resumeKey)) {
      skippedSessions += 1;
      continue;
    }
    resumeKeys.add(resumeKey);

    const subtitle = trimmedString(candidate.subtitle);
    const model = trimmedString(candidate.chatModel);
    const createdAt = isoFromNonNegativeEpochMillis(candidate.lastActionAt);
    const common = {
      legacyId,
      projectPath,
      title,
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(model === undefined ? {} : { model }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(route === undefined ? {} : { legacyRoute: route }),
    };
    threads.push(
      provider === "codex"
        ? { ...common, provider, resumeCursor: { threadId: sessionId } }
        : { ...common, provider, resumeCursor: { resume: sessionId } },
    );
  }

  const settings = isRecord(value.settings) ? value.settings : undefined;
  const routingModel = trimmedString(settings?.codexSubagentModel);
  const hasRoutedClaudeSession = threads.some(
    (thread) => thread.legacyRoute === "codex-via-claude" || thread.legacyRoute === "hybrid",
  );
  const claudeCodexRouting =
    (settings?.claudeRoute === "hybrid" && settings.codexSubagents === true) ||
    hasRoutedClaudeSession
      ? {
          enabled: true as const,
          ...(routingModel === undefined ? {} : { model: routingModel }),
        }
      : undefined;

  return {
    projects,
    threads,
    ...(claudeCodexRouting === undefined ? {} : { claudeCodexRouting }),
    skippedSessions,
  };
};

const readOptionalFile = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  operation: Legacy2CodeMigrationError["operation"],
) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(new Legacy2CodeMigrationError({ operation, path: filePath, cause })),
    ),
  );

const ensurePrivateDirectory = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<void, Legacy2CodeMigrationError> =>
  fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.andThen(fileSystem.chmod(directory, 0o700)),
    Effect.mapError(
      (cause) =>
        new Legacy2CodeMigrationError({
          operation: "create-private-directory",
          path: directory,
          cause,
        }),
    ),
  );

const writePrivateFileAtomically = Effect.fn("desktop.legacy2code.writePrivateFileAtomically")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly filePath: string;
    readonly contents: string;
    readonly operation:
      | "write-snapshot"
      | "write-manifest"
      | "write-codex-auth-backup"
      | "write-codex-auth-target";
  }): Effect.fn.Return<void, Legacy2CodeMigrationError> {
    const tempPath = `${input.filePath}.${process.pid}.tmp`;
    yield* Effect.gen(function* () {
      yield* input.fileSystem.writeFileString(tempPath, input.contents);
      yield* input.fileSystem.chmod(tempPath, 0o600);
      yield* input.fileSystem.rename(tempPath, input.filePath);
      yield* input.fileSystem.chmod(input.filePath, 0o600);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new Legacy2CodeMigrationError({
            operation: input.operation,
            path: input.filePath,
            cause,
          }),
      ),
      Effect.ensuring(input.fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
  },
);

const isCodexCredential = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const type = String(value.type ?? value.provider ?? "").toLowerCase();
  return (
    type === "codex" ||
    (typeof value.refresh_token === "string" && typeof value.access_token === "string")
  );
};

interface CredentialSnapshot {
  readonly name: string;
  readonly contents: string;
}

const readValidCredentialFiles = Effect.fn("desktop.legacy2code.readValidCredentialFiles")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly directory: string;
  }): Effect.fn.Return<ReadonlyArray<CredentialSnapshot>, Legacy2CodeMigrationError> {
    const names = yield* input.fileSystem.readDirectory(input.directory).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.fail(
              new Legacy2CodeMigrationError({
                operation: "read-codex-auth",
                path: input.directory,
                cause,
              }),
            ),
      ),
    );
    const credentials: Array<CredentialSnapshot> = [];
    for (const name of names.toSorted()) {
      if (
        !name.endsWith(".json") ||
        name.length > 255 ||
        name.includes("/") ||
        name.includes("\\")
      ) {
        continue;
      }
      const filePath = input.directory.endsWith("/")
        ? `${input.directory}${name}`
        : `${input.directory}/${name}`;
      const stat = yield* input.fileSystem.stat(filePath).pipe(Effect.option);
      if (
        Option.isNone(stat) ||
        stat.value.type !== "File" ||
        stat.value.size > MAX_CREDENTIAL_BYTES
      ) {
        continue;
      }
      const contents = yield* input.fileSystem.readFileString(filePath).pipe(Effect.option);
      if (Option.isNone(contents)) continue;
      const parsed = yield* decodeUnknownJson(contents.value).pipe(Effect.option);
      if (Option.isSome(parsed) && isCodexCredential(parsed.value)) {
        credentials.push({ name, contents: contents.value });
      }
    }
    return credentials;
  },
);

const migrateCodexBridgeAuth = Effect.fn("desktop.legacy2code.migrateCodexBridgeAuth")(
  function* (input: {
    readonly legacyUserDataPath: string;
    readonly targetStateDir: string;
    readonly migrationDirectory: string;
  }): Effect.fn.Return<
    Legacy2CodeAuthMigrationStatus,
    Legacy2CodeMigrationError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceDirectory = path.join(
      input.legacyUserDataPath,
      "providers",
      "codex-via-claude",
      "auth",
    );
    const backupDirectory = path.join(
      input.migrationDirectory,
      LEGACY_CODEX_AUTH_BACKUP_DIRECTORY_NAME,
    );
    const targetDirectory = path.join(
      input.targetStateDir,
      "providers",
      "claude-codex-bridge",
      "auth",
    );

    const targetCredentials = yield* readValidCredentialFiles({
      fileSystem,
      directory: targetDirectory,
    });
    if (targetCredentials.length > 0) return "already-present";

    let credentials = yield* readValidCredentialFiles({ fileSystem, directory: backupDirectory });
    if (credentials.length === 0) {
      const sourceExists = yield* fileSystem
        .exists(sourceDirectory)
        .pipe(Effect.orElseSucceed(() => false));
      if (!sourceExists) return "not-found";
      credentials = yield* readValidCredentialFiles({ fileSystem, directory: sourceDirectory });
      if (credentials.length === 0) return "no-valid-credentials";
      yield* ensurePrivateDirectory(fileSystem, backupDirectory);
      for (const credential of credentials) {
        yield* writePrivateFileAtomically({
          fileSystem,
          filePath: path.join(backupDirectory, credential.name),
          contents: credential.contents,
          operation: "write-codex-auth-backup",
        });
      }
    }

    yield* ensurePrivateDirectory(fileSystem, targetDirectory);
    for (const credential of credentials) {
      const preferredPath = path.join(targetDirectory, credential.name);
      const destinationPath = (yield* fileSystem
        .exists(preferredPath)
        .pipe(Effect.orElseSucceed(() => false)))
        ? path.join(targetDirectory, `legacy-2code-${credential.name}`)
        : preferredPath;
      if (yield* fileSystem.exists(destinationPath).pipe(Effect.orElseSucceed(() => false))) {
        continue;
      }
      yield* writePrivateFileAtomically({
        fileSystem,
        filePath: destinationPath,
        contents: credential.contents,
        operation: "write-codex-auth-target",
      });
    }
    return "copied";
  },
);

const prepareWorkspaceImport = Effect.fn("desktop.legacy2code.prepareWorkspaceImport")(
  function* (input: {
    readonly legacyUserDataPath: string;
    readonly migrationDirectory: string;
  }): Effect.fn.Return<
    Omit<Legacy2CodeMigrationResult, "authStatus">,
    Legacy2CodeMigrationError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const sourcePath = path.join(input.legacyUserDataPath, "config", "workspace.json");
    const backupSourcePath = `${sourcePath}.backup`;
    const snapshotPath = path.join(input.migrationDirectory, LEGACY_WORKSPACE_SNAPSHOT_NAME);
    const backupSnapshotPath = path.join(
      input.migrationDirectory,
      LEGACY_WORKSPACE_BACKUP_SNAPSHOT_NAME,
    );
    const manifestPath = path.join(input.migrationDirectory, LEGACY_2CODE_IMPORT_MANIFEST_NAME);

    const captureSnapshot = Effect.fn("desktop.legacy2code.captureWorkspaceSnapshot")(
      function* (candidate: {
        readonly sourcePath: string;
        readonly snapshotPath: string;
      }): Effect.fn.Return<Option.Option<LegacyWorkspaceSnapshot>, Legacy2CodeMigrationError> {
        let snapshot = yield* readOptionalFile(fileSystem, candidate.snapshotPath, "read-snapshot");
        if (Option.isNone(snapshot)) {
          const source = yield* readOptionalFile(fileSystem, candidate.sourcePath, "read-source");
          if (Option.isNone(source)) return Option.none();
          yield* writePrivateFileAtomically({
            fileSystem,
            filePath: candidate.snapshotPath,
            contents: source.value,
            operation: "write-snapshot",
          });
          snapshot = source;
        }
        return Option.some({ ...candidate, contents: snapshot.value });
      },
    );

    // Freeze both recovery candidates before decoding either one. A malformed
    // primary can therefore fall back without ever re-reading or rewriting the
    // legacy app's rotating backup.
    const primarySnapshot = yield* captureSnapshot({ sourcePath, snapshotPath });
    const backupSnapshot = yield* captureSnapshot({
      sourcePath: backupSourcePath,
      snapshotPath: backupSnapshotPath,
    });
    const candidates = [primarySnapshot, backupSnapshot].flatMap((candidate) =>
      Option.match(candidate, { onNone: () => [], onSome: (value) => [value] }),
    );
    if (candidates.length === 0) {
      return {
        workspaceStatus: "not-found",
        projectCount: 0,
        threadCount: 0,
        skippedSessionCount: 0,
      };
    }

    let selected:
      | {
          readonly snapshot: LegacyWorkspaceSnapshot;
          readonly projection: LegacyWorkspaceProjection;
        }
      | undefined;
    let firstDecodeFailure: Legacy2CodeMigrationError | undefined;
    for (const snapshot of candidates) {
      const decoded = yield* Effect.result(
        decodeUnknownJson(snapshot.contents).pipe(
          Effect.mapError(
            (cause) =>
              new Legacy2CodeMigrationError({
                operation: "decode-workspace",
                path: snapshot.snapshotPath,
                cause,
              }),
          ),
          Effect.flatMap((parsed) =>
            Effect.try({
              try: () => normalizeLegacyWorkspace(parsed, path),
              catch: (cause) =>
                new Legacy2CodeMigrationError({
                  operation: "decode-workspace",
                  path: snapshot.snapshotPath,
                  cause,
                }),
            }),
          ),
        ),
      );
      if (decoded._tag === "Success") {
        selected = { snapshot, projection: decoded.success };
        break;
      }
      firstDecodeFailure ??= decoded.failure;
    }
    if (selected === undefined) {
      return yield* (
        firstDecodeFailure ??
          new Legacy2CodeMigrationError({
            operation: "decode-workspace",
            path: snapshotPath,
            cause: new Error("No legacy workspace snapshot could be decoded."),
          })
      );
    }

    const checksum = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(selected.snapshot.contents))
      .pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(
          (cause) =>
            new Legacy2CodeMigrationError({
              operation: "hash-snapshot",
              path: selected.snapshot.snapshotPath,
              cause,
            }),
        ),
      );

    const existingManifest = yield* readOptionalFile(fileSystem, manifestPath, "read-manifest");
    if (Option.isSome(existingManifest)) {
      const decoded = yield* decodeLegacy2CodeImportManifestJson(existingManifest.value).pipe(
        Effect.mapError(
          (cause) =>
            new Legacy2CodeMigrationError({
              operation: "read-manifest",
              path: manifestPath,
              cause,
            }),
        ),
      );
      if (
        decoded.source.sha256 !== checksum ||
        decoded.source.workspacePath !== selected.snapshot.sourcePath
      ) {
        return yield* new Legacy2CodeMigrationError({
          operation: "read-manifest",
          path: manifestPath,
          cause: new Error("The immutable legacy snapshot does not match its import manifest."),
        });
      }
      return {
        workspaceStatus: "already-prepared",
        projectCount: decoded.projects.length,
        threadCount: decoded.threads.length,
        skippedSessionCount: decoded.skippedSessions,
      };
    }

    const manifest: Legacy2CodeImportManifest = {
      version: 1,
      source: { workspacePath: selected.snapshot.sourcePath, sha256: checksum },
      projects: selected.projection.projects,
      threads: selected.projection.threads,
      ...(selected.projection.claudeCodexRouting === undefined
        ? {}
        : { claudeCodexRouting: selected.projection.claudeCodexRouting }),
      skippedSessions: selected.projection.skippedSessions,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    const encoded = yield* encodeLegacy2CodeImportManifestJson(manifest).pipe(
      Effect.mapError(
        (cause) =>
          new Legacy2CodeMigrationError({
            operation: "write-manifest",
            path: manifestPath,
            cause,
          }),
      ),
    );
    yield* writePrivateFileAtomically({
      fileSystem,
      filePath: manifestPath,
      contents: `${encoded}\n`,
      operation: "write-manifest",
    });
    return {
      workspaceStatus: "prepared",
      projectCount: selected.projection.projects.length,
      threadCount: selected.projection.threads.length,
      skippedSessionCount: selected.projection.skippedSessions,
    };
  },
);

export const prepareLegacy2CodeImport = Effect.fn("desktop.legacy2code.prepareImport")(
  function* (input: {
    readonly legacyUserDataPath: string;
    readonly targetStateDir: string;
  }): Effect.fn.Return<
    Legacy2CodeMigrationResult,
    never,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationDirectory = path.join(
      input.targetStateDir,
      "migrations",
      MIGRATION_DIRECTORY_NAME,
    );

    const directoryResult = yield* Effect.result(
      ensurePrivateDirectory(fileSystem, migrationDirectory),
    );
    if (directoryResult._tag === "Failure") {
      yield* logWarning("could not create private migration directory", {
        error: errorMessage(directoryResult.failure),
      });
      return {
        workspaceStatus: "failed",
        authStatus: "failed",
        projectCount: 0,
        threadCount: 0,
        skippedSessionCount: 0,
      };
    }

    const authResult = yield* Effect.result(
      migrateCodexBridgeAuth({
        legacyUserDataPath: input.legacyUserDataPath,
        targetStateDir: input.targetStateDir,
        migrationDirectory,
      }),
    );
    if (authResult._tag === "Failure") {
      yield* logWarning("legacy Codex bridge credential copy failed", {
        error: errorMessage(authResult.failure),
      });
    }

    const workspaceResult = yield* Effect.result(
      prepareWorkspaceImport({
        legacyUserDataPath: input.legacyUserDataPath,
        migrationDirectory,
      }),
    );
    if (workspaceResult._tag === "Failure") {
      yield* logWarning("legacy workspace import preparation failed", {
        error: errorMessage(workspaceResult.failure),
      });
      return {
        workspaceStatus: "failed",
        authStatus: authResult._tag === "Success" ? authResult.success : "failed",
        projectCount: 0,
        threadCount: 0,
        skippedSessionCount: 0,
      };
    }

    return {
      ...workspaceResult.success,
      authStatus: authResult._tag === "Success" ? authResult.success : "failed",
    };
  },
);

/** Run only in the signed compatibility distribution; default T3 and dev never inspect 2code. */
export const runLegacy2CodeMigration = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (
    environment.distributionId !== "2code-production" ||
    !environment.isPackaged ||
    environment.platform !== "darwin"
  ) {
    return;
  }

  const result = yield* prepareLegacy2CodeImport({
    legacyUserDataPath: environment.path.join(environment.appDataDirectory, "2code"),
    targetStateDir: environment.stateDir,
  });
  yield* logInfo("legacy 2code migration checked", { ...result });
}).pipe(Effect.withSpan("desktop.legacy2code.run"));
