import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/unstable/http";
import {
  readPersistedT3WorkProjectSetupState,
  renderT3WorkProjectSetupFiles,
  resolveT3WorkProjectSetupProfileId,
  resolveT3WorkProjectSetupWriteDecision,
  T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
} from "./t3work-projectSetup.ts";
import {
  errorResponse,
  okJson,
  readJsonBody,
  T3workAtlassianError,
  toAtlassianError,
} from "./t3work-atlassian-http.ts";
import {
  ensureWorkspaceGitRepository,
  ensureWorkspaceGitignore,
  syncLinkedRepository,
  writeReferenceManifest,
} from "./t3work-project-repository-services.ts";
import {
  deriveReferenceDirectoryName,
  HIDDEN_T3WORK_DIR,
  normalizeT3workWorkspaceRoot,
  normalizeRepositoryUrls,
  REFERENCES_DIR_NAME,
  toT3workError,
} from "./t3work-project-repository-utils.ts";
import type {
  BootstrapWorkspaceRequest,
  BootstrapWorkspaceResponse,
  LinkedRepositoryBootstrapResult,
  ReferenceManifestFile,
} from "./t3work-project-repository-utils.ts";

export const t3workProjectWorkspaceBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/project/workspace/bootstrap",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const input = yield* readJsonBody<BootstrapWorkspaceRequest>();
    const workspaceRootInput = input.workspaceRoot?.trim() ?? "";
    if (workspaceRootInput.length === 0)
      return yield* new T3workAtlassianError({ message: "workspaceRoot is required." });
    const workspaceRoot = yield* normalizeT3workWorkspaceRoot(workspaceRootInput);

    yield* fileSystem
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError(toAtlassianError("Failed to ensure workspace directory exists.")));

    const persistedProfilePath = path.join(workspaceRoot, T3WORK_PROJECT_PROFILE_MANIFEST_PATH);
    const persistedProfileExists = yield* fileSystem
      .exists(persistedProfilePath)
      .pipe(Effect.orElseSucceed(() => false));
    const persistedSetupState = persistedProfileExists
      ? readPersistedT3WorkProjectSetupState(
          yield* fileSystem
            .readFileString(persistedProfilePath)
            .pipe(Effect.orElseSucceed(() => "")),
        )
      : { managedFileHashes: {} };
    const setupProfileId = resolveT3WorkProjectSetupProfileId(
      input.customProfile?.id ?? input.setupProfileId ?? persistedSetupState.profileId,
    );
    const previewSetupFiles = renderT3WorkProjectSetupFiles({
      profileId: setupProfileId,
      ...(input.customProfile ? { customProfile: input.customProfile } : {}),
    });
    const writeDecisions = new Map<
      string,
      ReturnType<typeof resolveT3WorkProjectSetupWriteDecision>
    >();
    const nextManagedFileHashes: Record<string, string> = {
      ...persistedSetupState.managedFileHashes,
    };

    for (const file of previewSetupFiles) {
      if (!file.managedRefresh) {
        continue;
      }

      const targetPath = path.join(workspaceRoot, file.relativePath);
      const exists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
      const currentContents = exists
        ? yield* fileSystem
            .readFileString(targetPath)
            .pipe(Effect.mapError(toAtlassianError("Failed to read workspace setup file.")))
        : undefined;
      const persistedManagedHash = persistedSetupState.managedFileHashes[file.relativePath];
      const decision = resolveT3WorkProjectSetupWriteDecision({
        file,
        ...(typeof currentContents === "string" ? { currentContents } : {}),
        ...(typeof persistedManagedHash === "string" ? { persistedManagedHash } : {}),
      });
      writeDecisions.set(file.relativePath, decision);
      if (decision.nextManagedHash) {
        nextManagedFileHashes[file.relativePath] = decision.nextManagedHash;
      }
    }

    const setupFiles = renderT3WorkProjectSetupFiles({
      profileId: setupProfileId,
      managedFileHashes: nextManagedFileHashes,
      ...(input.customProfile ? { customProfile: input.customProfile } : {}),
    });
    for (const file of setupFiles) {
      const targetPath = path.join(workspaceRoot, file.relativePath);
      const exists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        if (file.writeMode === "overwrite") {
          // Always rewrite the manifest so stored scaffold hashes stay current.
        } else if (!writeDecisions.get(file.relativePath)?.shouldWrite) {
          continue;
        }
      }
      yield* fileSystem
        .makeDirectory(path.dirname(targetPath), { recursive: true })
        .pipe(Effect.mapError(toAtlassianError("Failed to create workspace setup directory.")));
      yield* fileSystem
        .writeFileString(targetPath, file.contents)
        .pipe(Effect.mapError(toAtlassianError("Failed to write workspace setup file.")));
    }

    const workspaceRepositoryInitialized = yield* ensureWorkspaceGitRepository(workspaceRoot);
    yield* ensureWorkspaceGitignore(workspaceRoot);

    const referencesRoot = path.join(workspaceRoot, HIDDEN_T3WORK_DIR, REFERENCES_DIR_NAME);
    yield* fileSystem
      .makeDirectory(referencesRoot, { recursive: true })
      .pipe(Effect.mapError(toAtlassianError("Failed to create repository references directory.")));

    const linkedRepositoryUrls = normalizeRepositoryUrls(input.linkedRepositoryUrls);
    const linkedRepositories: LinkedRepositoryBootstrapResult[] = [];
    for (const [index, url] of linkedRepositoryUrls.entries()) {
      const result = yield* syncLinkedRepository({
        workspaceRoot,
        referencesRoot,
        url,
        index,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            url,
            localPath: path.join(
              referencesRoot,
              `${String(index + 1).padStart(2, "0")}-${deriveReferenceDirectoryName(url)}`,
            ),
            status: "failed",
            error:
              error instanceof T3workAtlassianError
                ? error.message
                : "Failed to sync linked repository reference.",
          } satisfies LinkedRepositoryBootstrapResult),
        ),
      );
      linkedRepositories.push(result);
    }

    const response: BootstrapWorkspaceResponse = {
      workspaceRoot,
      workspaceRepositoryInitialized,
      referencesRoot,
      linkedRepositories,
    };
    const manifest: ReferenceManifestFile = {
      ...response,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };

    yield* writeReferenceManifest(referencesRoot, manifest);
    return okJson(response);
  }).pipe(
    Effect.mapError((cause) => toT3workError(cause, "Failed to bootstrap project workspace.")),
    Effect.catch(errorResponse),
  ),
);
