import type { ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BoardId,
  LaneKey,
  StepKey,
  WorkflowDefinition,
  WorkflowLintError,
  type WorkflowBoardVersionSource,
  type WorkflowBoardVersionSummary,
  type WorkflowDefinitionEncoded,
  type WorkflowLintError as WorkflowLintErrorType,
  WorkflowRpcError,
} from "../../contracts/workflow.ts";
import {
  MAX_IMPORT_DEFINITION_CHARS,
  definitionLaneCapViolation,
  exceedsDefinitionCharCap,
} from "./definitionCaps.ts";
import { type LintError, encodeWorkflowDefinitionJson } from "./workflowFile.ts";
import { sha256Hex } from "./workflowVersionHash.ts";
import { ProjectWorkspaceResolver } from "./Services/ProjectWorkspaceResolver.ts";
import {
  type BoardRow,
  WorkflowReadModel,
} from "./Services/WorkflowReadModel.ts";
import { WorkflowBoardSaveLocks } from "./Services/WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStore } from "./Services/WorkflowBoardVersionStore.ts";
import { WorkflowFileLoader } from "./Services/WorkflowFileLoader.ts";
import { WorkflowFilesystemCapability } from "./Services/WorkflowCapabilities.ts";

type WorkflowBoardDefinitionWriteContext =
  | WorkflowReadModel
  | ProjectWorkspaceResolver
  | WorkflowFileLoader
  | WorkflowBoardVersionStore
  | WorkflowBoardSaveLocks;

const workflowRpcError = (message: string, cause?: unknown) =>
  new WorkflowRpcError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const toWorkflowRpcError = (message: string) => (cause: unknown) =>
  workflowRpcError(message, cause);

export const WORKFLOW_BOARD_FILE_PATH_PATTERN = /^\.t3\/boards\/[A-Za-z0-9_-]+\.json$/;

export const isWorkflowBoardFilePath = (path: string): boolean =>
  WORKFLOW_BOARD_FILE_PATH_PATTERN.test(path);

export const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
export const decodeWorkflowDefinitionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkflowDefinition),
);
export const encodeWorkflowDefinition = Schema.encodeSync(WorkflowDefinition);

export const workflowDefinitionContentJson = (definition: WorkflowDefinition): string =>
  `${encodeWorkflowDefinitionJson(definition)}\n`;

export const workflowDefinitionVersionHash = (definition: WorkflowDefinition): string =>
  sha256Hex(workflowDefinitionContentJson(definition));

const toContractLintError = (error: LintError): WorkflowLintErrorType => ({
  code: error.code,
  message: error.message,
  ...(error.laneKey === undefined ? {} : { laneKey: LaneKey.make(error.laneKey) }),
  ...(error.stepKey === undefined ? {} : { stepKey: StepKey.make(error.stepKey) }),
  ...(error.transitionIndex === undefined ? {} : { transitionIndex: error.transitionIndex }),
});

export const recordBoardVersionBestEffort = (input: {
  readonly boardId: BoardId;
  readonly versionHash: string;
  readonly contentJson: string;
  readonly source: WorkflowBoardVersionSource;
}): Effect.Effect<void, never, WorkflowBoardVersionStore> =>
  Effect.gen(function* () {
    const versionStore = yield* WorkflowBoardVersionStore;
    yield* versionStore.record(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to record workflow board version", {
          boardId: input.boardId,
          source: input.source,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

export const recordBoardVersionRequired = (input: {
  readonly boardId: BoardId;
  readonly versionHash: string;
  readonly contentJson: string;
  readonly source: WorkflowBoardVersionSource;
}): Effect.Effect<void, WorkflowRpcError, WorkflowBoardVersionStore> =>
  Effect.gen(function* () {
    const versionStore = yield* WorkflowBoardVersionStore;
    yield* versionStore
      .record(input)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to record workflow board version")));
  });

export interface WritableWorkflowBoardFile {
  readonly board: BoardRow;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly currentRaw: string;
}

export const loadWritableWorkflowBoardFile = (
  filesystem: WorkflowFilesystemCapability["Service"],
  boardId: BoardId,
): Effect.Effect<
  WritableWorkflowBoardFile,
  WorkflowRpcError,
  WorkflowReadModel | ProjectWorkspaceResolver
> =>
  Effect.gen(function* () {
    const readModel = yield* WorkflowReadModel;
    const projectWorkspaceResolver = yield* ProjectWorkspaceResolver;
    const board = yield* readModel
      .getBoard(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
    }

    if (!isWorkflowBoardFilePath(board.workflowFilePath)) {
      return yield* workflowRpcError(`Workflow board ${boardId} is not a writable workflow board file`);
    }

    const projectId = board.projectId as ProjectId;
    const workspaceRoot = yield* projectWorkspaceResolver
      .resolve(projectId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
    const currentRaw = yield* filesystem
      .readFileString({
        root: workspaceRoot,
        relativePath: board.workflowFilePath,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to read workflow board file")));

    return {
      board,
      projectId,
      workspaceRoot,
      currentRaw,
    };
  });

interface PersistedWorkflowBoardDefinition {
  readonly _tag: "persisted";
  readonly definition: WorkflowDefinitionEncoded;
  readonly versionHash: string;
  readonly contentJson: string;
}

interface WorkflowBoardDefinitionLintFailure {
  readonly _tag: "lintErrors";
  readonly lintErrors: ReadonlyArray<WorkflowLintErrorType>;
}

export type PersistWorkflowBoardDefinitionResult =
  | PersistedWorkflowBoardDefinition
  | WorkflowBoardDefinitionLintFailure;

const isMissingFilesystemPath = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { readonly _tag?: unknown })._tag === "FilesystemPathError" &&
  "reason" in error &&
  (error as { readonly reason?: unknown }).reason === "path does not exist";

export const persistWorkflowBoardDefinition = (
  filesystem: WorkflowFilesystemCapability["Service"],
  input: {
    readonly boardId: BoardId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly definition: WorkflowDefinition;
    readonly source: WorkflowBoardVersionSource;
    readonly notFoundAfterWriteMessage: string;
    readonly versionRecording?: "best-effort" | "required";
  },
): Effect.Effect<PersistWorkflowBoardDefinitionResult, WorkflowRpcError, WorkflowBoardDefinitionWriteContext> =>
  Effect.gen(function* () {
    const readModel = yield* WorkflowReadModel;
    const fileLoader = yield* WorkflowFileLoader;
    const contentJson = workflowDefinitionContentJson(input.definition);
    const tooLarge = (message: string): PersistWorkflowBoardDefinitionResult => ({
      _tag: "lintErrors",
      lintErrors: [{ code: "invalid_step", message }],
    });
    if (exceedsDefinitionCharCap(contentJson.length)) {
      return tooLarge(
        `Board definition is too large to save (exceeds ${MAX_IMPORT_DEFINITION_CHARS} characters)`,
      );
    }
    const laneCapViolation = definitionLaneCapViolation(input.definition);
    if (laneCapViolation !== null) {
      return tooLarge(laneCapViolation);
    }

    const lintErrors = yield* fileLoader
      .lintDefinition({
        definition: input.definition,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("workflow lint failed")));
    if (lintErrors.length > 0) {
      return { _tag: "lintErrors", lintErrors: lintErrors.map(toContractLintError) };
    }

    const previousContents = yield* filesystem
      .readFileString({ root: input.workspaceRoot, relativePath: input.relativePath })
      .pipe(
        Effect.map((contents): string | null => contents),
        Effect.catch((error) =>
          isMissingFilesystemPath(error)
            ? Effect.succeed<string | null>(null)
            : Effect.fail(
                toWorkflowRpcError("Failed to read existing workflow board file before save")(
                  error,
                ),
              ),
        ),
      );

    yield* filesystem
      .writeFileString({
        root: input.workspaceRoot,
        relativePath: input.relativePath,
        contents: contentJson,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to write workflow board file")));

    const finalize = Effect.gen(function* () {
      yield* fileLoader
        .loadAndRegister({
          boardId: input.boardId,
          projectId: input.projectId,
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        })
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to register saved workflow board")));

      const updatedBoard = yield* readModel
        .getBoard(input.boardId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to load saved workflow board")));
      if (!updatedBoard) {
        return yield* workflowRpcError(input.notFoundAfterWriteMessage);
      }
      const versionRecordInput = {
        boardId: input.boardId,
        versionHash: updatedBoard.workflowVersionHash,
        contentJson,
        source: input.source,
      };
      if (input.versionRecording === "required") {
        yield* recordBoardVersionRequired(versionRecordInput);
      } else {
        yield* recordBoardVersionBestEffort(versionRecordInput);
      }

      return {
        _tag: "persisted" as const,
        definition: encodeWorkflowDefinition(input.definition),
        versionHash: updatedBoard.workflowVersionHash,
        contentJson,
      };
    });

    return yield* finalize.pipe(
      Effect.tapError(() =>
        (previousContents === null
          ? filesystem.remove({
              root: input.workspaceRoot,
              relativePath: input.relativePath,
            })
          : filesystem.writeFileString({
              root: input.workspaceRoot,
              relativePath: input.relativePath,
              contents: previousContents,
            })
        ).pipe(Effect.ignore),
      ),
    );
  });

const toBoardVersionSummary = (
  version: {
    readonly versionId: number;
    readonly versionHash: string;
    readonly source: WorkflowBoardVersionSource;
    readonly createdAt: string;
  },
  index: number,
): WorkflowBoardVersionSummary => ({
  versionId: version.versionId,
  versionHash: version.versionHash,
  source: version.source,
  createdAt: version.createdAt,
  isCurrent: index === 0,
});

const backfillImportedBoardVersion = (
  filesystem: WorkflowFilesystemCapability["Service"],
  boardId: BoardId,
): Effect.Effect<
  void,
  WorkflowRpcError,
  WorkflowReadModel | ProjectWorkspaceResolver | WorkflowBoardVersionStore
> =>
  Effect.gen(function* () {
    const readModel = yield* WorkflowReadModel;
    const projectWorkspaceResolver = yield* ProjectWorkspaceResolver;
    const versionStore = yield* WorkflowBoardVersionStore;
    const board = yield* readModel
      .getBoard(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
    }

    const projectId = board.projectId as ProjectId;
    const workspaceRoot = yield* projectWorkspaceResolver
      .resolve(projectId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
    const contentJson = yield* filesystem
      .readFileString({
        root: workspaceRoot,
        relativePath: board.workflowFilePath,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to read workflow board file")));
    const versionHash = sha256Hex(contentJson);
    if (versionHash !== board.workflowVersionHash) {
      yield* Effect.logWarning("Skipping workflow board version import for stale projection", {
        boardId,
        projectedVersionHash: board.workflowVersionHash,
        fileVersionHash: versionHash,
      });
      return;
    }

    yield* versionStore
      .record({
        boardId,
        versionHash,
        contentJson,
        source: "import",
      })
      .pipe(
        Effect.mapError(toWorkflowRpcError("Failed to record imported workflow board version")),
      );
  });

export const listBoardVersions = (
  filesystem: WorkflowFilesystemCapability["Service"],
  boardId: BoardId,
): Effect.Effect<
  ReadonlyArray<WorkflowBoardVersionSummary>,
  WorkflowRpcError,
  WorkflowBoardDefinitionWriteContext
> =>
  Effect.gen(function* () {
    const versionStore = yield* WorkflowBoardVersionStore;
    const existing = yield* versionStore
      .list(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
    if (existing.length > 0) {
      return existing.map(toBoardVersionSummary);
    }

    const saveLocks = yield* WorkflowBoardSaveLocks;
    yield* saveLocks.withSaveLock(
      boardId,
      Effect.gen(function* () {
        const lockedExisting = yield* versionStore
          .list(boardId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
        if (lockedExisting.length > 0) {
          return;
        }
        yield* backfillImportedBoardVersion(filesystem, boardId);
      }),
    );
    const imported = yield* versionStore
      .list(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
    return imported.map(toBoardVersionSummary);
  });

export const getBoardVersion = (
  boardId: BoardId,
  versionId: number,
): Effect.Effect<
  {
    readonly versionId: number;
    readonly definition: WorkflowDefinitionEncoded;
    readonly versionHash: string;
    readonly source: WorkflowBoardVersionSource;
    readonly createdAt: string;
  },
  WorkflowRpcError,
  WorkflowBoardVersionStore
> =>
  Effect.gen(function* () {
    const versionStore = yield* WorkflowBoardVersionStore;
    const version = yield* versionStore
      .get(boardId, versionId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board version")));
    if (!version) {
      return yield* workflowRpcError(
        `Workflow board version ${versionId} was not found for board ${boardId}`,
      );
    }

    const definition = yield* decodeWorkflowDefinitionJson(version.contentJson).pipe(
      Effect.mapError(toWorkflowRpcError("workflow board version decode failed")),
    );
    return {
      versionId: version.versionId,
      definition: encodeWorkflowDefinition(definition),
      versionHash: version.versionHash,
      source: version.source,
      createdAt: version.createdAt,
    };
  });
