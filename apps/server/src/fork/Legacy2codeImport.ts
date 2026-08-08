import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IsoDateTime,
  type ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  decodeLegacy2CodeImportManifestJson,
  type Legacy2CodeImportManifest,
  type Legacy2CodeImportThread,
} from "@t3tools/shared/fork/legacy2codeImport";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

const MIGRATION_DIRECTORY_NAME = "legacy-2code-electron-v1";
const IMPORT_MANIFEST_FILE_NAME = "import.json";
const RECEIPT_FILE_PREFIX = "receipt-";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

export interface Legacy2CodeImportPaths {
  readonly migrationDirectory: string;
  readonly manifestPath: string;
  readonly receiptPathForSource: (sourceSha256: string) => string;
}

export type Legacy2CodeImportOutcome =
  | { readonly status: "not-found"; readonly manifestPath: string }
  | {
      readonly status: "already-imported";
      readonly manifestPath: string;
      readonly receiptPath: string;
      readonly sourceSha256: string;
    }
  | {
      readonly status: "imported";
      readonly manifestPath: string;
      readonly receiptPath: string;
      readonly sourceSha256: string;
      readonly projectsCreated: number;
      readonly projectsReused: number;
      readonly threadsCreated: number;
      readonly threadsReused: number;
    };

const Legacy2CodeImportReceipt = Schema.Struct({
  version: Schema.Literal(1),
  sourceSha256: Schema.String,
  manifestPath: Schema.String,
  projectsCreated: NonNegativeInt,
  projectsReused: NonNegativeInt,
  threadsCreated: NonNegativeInt,
  threadsReused: NonNegativeInt,
  skippedSessions: NonNegativeInt,
  importedAt: IsoDateTime,
});
type Legacy2CodeImportReceipt = typeof Legacy2CodeImportReceipt.Type;
const encodeLegacy2CodeImportReceipt = Schema.encodeEffect(
  Schema.fromJsonString(Legacy2CodeImportReceipt),
);
const decodeLegacy2CodeImportReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Legacy2CodeImportReceipt),
);

const stableHash = (...parts: ReadonlyArray<string>): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
};

const stableProjectId = (manifest: Legacy2CodeImportManifest, workspaceRoot: string) =>
  ProjectId.make(
    `legacy-2code-project-${stableHash(manifest.source.workspacePath, workspaceRoot).slice(0, 32)}`,
  );

const stableThreadId = (manifest: Legacy2CodeImportManifest, legacyThreadId: string) =>
  ThreadId.make(
    `legacy-2code-thread-${stableHash(manifest.source.workspacePath, legacyThreadId).slice(0, 32)}`,
  );

const stableCommandId = (operation: string, ...parts: ReadonlyArray<string>) =>
  CommandId.make(`legacy-2code-${operation}-${stableHash(operation, ...parts).slice(0, 32)}`);

export const resolveLegacy2CodeImportPaths = (
  stateDir: string,
  path: Pick<Path.Path, "join">,
): Legacy2CodeImportPaths => {
  const migrationDirectory = path.join(stateDir, "migrations", MIGRATION_DIRECTORY_NAME);
  return {
    migrationDirectory,
    manifestPath: path.join(migrationDirectory, IMPORT_MANIFEST_FILE_NAME),
    receiptPathForSource: (sourceSha256) =>
      path.join(
        migrationDirectory,
        `${RECEIPT_FILE_PREFIX}${stableHash(sourceSha256).slice(0, 32)}.json`,
      ),
  };
};

const providerForThread = (thread: Legacy2CodeImportThread) =>
  thread.provider === "claude" ? CLAUDE_DRIVER : CODEX_DRIVER;

const modelSelectionForThread = (thread: Legacy2CodeImportThread): ModelSelection => {
  const provider = providerForThread(thread);
  const fallbackModel = DEFAULT_MODEL_BY_PROVIDER[provider];
  if (!thread.model && !fallbackModel) {
    throw new Error(`No default model is configured for legacy provider '${thread.provider}'.`);
  }
  return {
    instanceId: ProviderInstanceId.make(provider),
    model: thread.model ?? fallbackModel!,
  };
};

const uniqueProjects = (manifest: Legacy2CodeImportManifest) => {
  const projects = new Map<string, string>();
  for (const project of manifest.projects) {
    if (!projects.has(project.legacyPath)) {
      projects.set(project.legacyPath, project.title);
    }
  }
  return projects;
};

/**
 * Imports one immutable desktop migration manifest into the event-sourced
 * server model. All identifiers and command receipts are stable so a crash
 * before the final receipt can safely retry without duplicating state.
 */
export const importLegacy2CodeManifest = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const paths = resolveLegacy2CodeImportPaths(serverConfig.stateDir, path);

  const manifestExists = yield* fileSystem.exists(paths.manifestPath);
  if (!manifestExists) {
    return {
      status: "not-found",
      manifestPath: paths.manifestPath,
    } satisfies Legacy2CodeImportOutcome;
  }

  const manifest = yield* fileSystem
    .readFileString(paths.manifestPath)
    .pipe(Effect.flatMap(decodeLegacy2CodeImportManifestJson));
  const receiptPath = paths.receiptPathForSource(manifest.source.sha256);
  if (yield* fileSystem.exists(receiptPath)) {
    const receipt = yield* fileSystem
      .readFileString(receiptPath)
      .pipe(Effect.flatMap(decodeLegacy2CodeImportReceipt), Effect.option);
    if (
      Option.isSome(receipt) &&
      receipt.value.sourceSha256 === manifest.source.sha256 &&
      receipt.value.manifestPath === paths.manifestPath
    ) {
      return {
        status: "already-imported",
        manifestPath: paths.manifestPath,
        receiptPath,
        sourceSha256: manifest.source.sha256,
      } satisfies Legacy2CodeImportOutcome;
    }
    yield* Effect.logWarning("legacy 2code import receipt is invalid; retrying idempotently", {
      receiptPath,
      sourceSha256: manifest.source.sha256,
    });
  }

  const projectIds = new Map<string, ProjectId>();
  let projectsCreated = 0;
  let projectsReused = 0;
  for (const [workspaceRoot, title] of uniqueProjects(manifest)) {
    const existingProject =
      yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(workspaceRoot);
    if (Option.isSome(existingProject)) {
      projectIds.set(workspaceRoot, existingProject.value.id);
      projectsReused += 1;
      continue;
    }

    const projectId = stableProjectId(manifest, workspaceRoot);
    yield* orchestrationEngine.dispatch({
      type: "project.create",
      commandId: stableCommandId("project-create", projectId),
      projectId,
      title,
      workspaceRoot,
      createdAt: manifest.createdAt,
    });
    projectIds.set(workspaceRoot, projectId);
    projectsCreated += 1;
  }

  let threadsCreated = 0;
  let threadsReused = 0;
  for (const thread of manifest.threads) {
    const projectId = projectIds.get(thread.projectPath);
    if (!projectId) {
      yield* Effect.logWarning("legacy 2code import skipped a thread with no project", {
        legacyThreadId: thread.legacyId,
        projectPath: thread.projectPath,
      });
      continue;
    }

    const threadId = stableThreadId(manifest, thread.legacyId);
    const modelSelection = modelSelectionForThread(thread);
    const existingThread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(existingThread)) {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: stableCommandId("thread-create", threadId),
        threadId,
        projectId,
        title: thread.title,
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: thread.createdAt ?? manifest.createdAt,
      });
      threadsCreated += 1;
    } else {
      threadsReused += 1;
    }

    if (thread.subtitle) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: stableCommandId(
            "thread-subtitle",
            threadId,
            manifest.source.sha256,
            thread.subtitle,
          ),
          threadId,
          subtitle: thread.subtitle,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("legacy 2code subtitle import was not supported", {
              threadId,
              cause,
            }),
          ),
        );
    }

    const provider = providerForThread(thread);
    yield* providerSessionDirectory.upsert({
      threadId,
      provider,
      providerInstanceId: ProviderInstanceId.make(provider),
      adapterKey: provider,
      status: "stopped",
      runtimeMode: "approval-required",
      resumeCursor: thread.resumeCursor,
      runtimePayload: {
        cwd: thread.projectPath,
        modelSelection,
      },
    });
  }

  if (manifest.claudeCodexRouting) {
    yield* serverSettings.updateSettings({
      providers: {
        claudeAgent: {
          codexRouting: {
            ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
            enabled: true,
            model: manifest.claudeCodexRouting.model ?? "",
          },
        },
      },
    });
  }

  const importedAt = DateTime.formatIso(yield* DateTime.now);
  const receipt: Legacy2CodeImportReceipt = {
    version: 1,
    sourceSha256: manifest.source.sha256,
    manifestPath: paths.manifestPath,
    projectsCreated,
    projectsReused,
    threadsCreated,
    threadsReused,
    skippedSessions: manifest.skippedSessions,
    importedAt,
  };
  const encodedReceipt = yield* encodeLegacy2CodeImportReceipt(receipt);
  yield* writeFileStringAtomically({
    filePath: receiptPath,
    contents: `${encodedReceipt}\n`,
  });

  return {
    status: "imported",
    manifestPath: paths.manifestPath,
    receiptPath,
    sourceSha256: manifest.source.sha256,
    projectsCreated,
    projectsReused,
    threadsCreated,
    threadsReused,
  } satisfies Legacy2CodeImportOutcome;
});

/** Startup-safe entry point: migration failures stay observable but never gate the server. */
export const runLegacy2CodeImportOnStartup = importLegacy2CodeManifest.pipe(
  Effect.tap((outcome) =>
    outcome.status === "imported"
      ? Effect.logInfo("legacy 2code import completed", outcome)
      : outcome.status === "already-imported"
        ? Effect.logDebug("legacy 2code import already completed", outcome)
        : Effect.void,
  ),
  Effect.catchCause((cause) =>
    Effect.logWarning("legacy 2code import failed; startup will continue", { cause }),
  ),
);
