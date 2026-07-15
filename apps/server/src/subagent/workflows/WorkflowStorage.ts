/**
 * WorkflowStorage - Dual storage (filesystem + database) for workflows.
 *
 * Primary: Filesystem at .claude/workflows/
 * Backup: Database table for redundancy
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  WorkflowDefinition,
  WorkflowMetadata,
  type WorkflowDefinition as WorkflowDefinitionType,
  type WorkflowMetadata as WorkflowMetadataType,
} from "./WorkflowSchema.ts";

export class WorkflowStorageError extends Schema.TaggedErrorClass<WorkflowStorageError>()(
  "WorkflowStorageError",
  {
    message: Schema.String,
    code: Schema.String,
  },
) {}

export interface WorkflowFilter {
  readonly name?: string;
  readonly version?: string;
}

export interface WorkflowStorageShape {
  readonly save: (
    workflow: WorkflowDefinitionType,
    metadata?: Partial<WorkflowMetadataType>,
  ) => Effect.Effect<string, WorkflowStorageError>;

  readonly load: (
    workflowId: string,
  ) => Effect.Effect<WorkflowDefinitionType, WorkflowStorageError>;

  readonly list: (
    filter?: WorkflowFilter,
  ) => Effect.Effect<ReadonlyArray<WorkflowMetadataType>, WorkflowStorageError>;

  readonly delete: (workflowId: string) => Effect.Effect<void, WorkflowStorageError>;

  readonly exists: (workflowId: string) => Effect.Effect<boolean>;
}

export class WorkflowStorage extends Context.Service<WorkflowStorage, WorkflowStorageShape>()(
  "t3/subagent/workflows/WorkflowStorage",
) {}

const WORKFLOWS_DIR = ".claude/workflows";
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PersistedWorkflow = Schema.Struct({
  metadata: WorkflowMetadata,
  workflow: WorkflowDefinition,
});
const PersistedWorkflowJson = Schema.fromJsonString(PersistedWorkflow);
const decodePersistedWorkflow = Schema.decodeUnknownEffect(PersistedWorkflowJson);
const encodePersistedWorkflow = Schema.encodeUnknownEffect(PersistedWorkflowJson);

const storageError = (message: string, code: string) => new WorkflowStorageError({ message, code });
const isWorkflowStorageError = Schema.is(WorkflowStorageError);

const wrapStorageError = (operation: string, code: string) => (cause: unknown) =>
  isWorkflowStorageError(cause)
    ? cause
    : storageError(
        `Failed to ${operation} workflow: ${cause instanceof Error ? cause.message : String(cause)}`,
        code,
      );

const toSafeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

const makeWorkflowStorage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Ensure workflows directory exists
  const ensureDir = Effect.gen(function* () {
    const workflowsPath = path.resolve(process.cwd(), WORKFLOWS_DIR);
    const exists = yield* fs.exists(workflowsPath);
    if (!exists) {
      yield* fs.makeDirectory(workflowsPath, { recursive: true });
    }
    return workflowsPath;
  });

  const resolveWorkflowPath = (workflowsPath: string, workflowId: string) =>
    Effect.gen(function* () {
      if (!SAFE_WORKFLOW_ID.test(workflowId)) {
        return yield* storageError("Invalid workflow ID", "INVALID_ID");
      }
      const root = path.resolve(workflowsPath);
      const candidate = path.resolve(root, `${workflowId}.json`);
      const relative = path.relative(root, candidate);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return yield* storageError("Workflow path escapes storage directory", "INVALID_ID");
      }
      return candidate;
    });

  const save: WorkflowStorageShape["save"] = (workflow, metadata) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;

      // Generate ID from name + version
      const workflowId = `${toSafeSlug(workflow.name)}-${toSafeSlug(workflow.version)}`;
      const filePath = yield* resolveWorkflowPath(workflowsPath, workflowId);

      const now = DateTime.formatIso(yield* DateTime.now);
      const fullMetadata: WorkflowMetadataType = {
        id: workflowId,
        name: workflow.name,
        version: workflow.version,
        description: workflow.description,
        createdAt: metadata?.createdAt ?? now,
        updatedAt: now,
      };

      const fileContent = yield* encodePersistedWorkflow({
        metadata: fullMetadata,
        workflow,
      });

      yield* fs.writeFileString(filePath, fileContent);

      // TODO: Sync to database as backup
      // yield* syncToDatabase(workflowId, workflow, fullMetadata);

      return workflowId;
    }).pipe(Effect.mapError(wrapStorageError("save", "SAVE_FAILED")));

  const load: WorkflowStorageShape["load"] = (workflowId) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;
      const filePath = yield* resolveWorkflowPath(workflowsPath, workflowId);

      const exists = yield* fs.exists(filePath);
      if (!exists) {
        // Try to restore from database
        // const restored = yield* restoreFromDatabase(workflowId);
        // if (restored) return restored;

        return yield* storageError(`Workflow ${workflowId} not found`, "NOT_FOUND");
      }

      const content = yield* fs.readFileString(filePath);
      return (yield* decodePersistedWorkflow(content)).workflow;
    }).pipe(Effect.mapError(wrapStorageError("load", "LOAD_FAILED")));

  const list: WorkflowStorageShape["list"] = (filter) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;

      const files = yield* fs.readDirectory(workflowsPath);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      const metadataList: WorkflowMetadataType[] = [];

      for (const file of jsonFiles) {
        const workflowId = file.slice(0, -".json".length);
        const filePath = yield* resolveWorkflowPath(workflowsPath, workflowId);
        const content = yield* fs.readFileString(filePath);
        const metadata = (yield* decodePersistedWorkflow(content)).metadata;

        if (filter?.name && metadata.name !== filter.name) continue;
        if (filter?.version && metadata.version !== filter.version) continue;

        metadataList.push(metadata);
      }

      return metadataList;
    }).pipe(Effect.mapError(wrapStorageError("list", "LIST_FAILED")));

  const deleteWorkflow: WorkflowStorageShape["delete"] = (workflowId) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;
      const filePath = yield* resolveWorkflowPath(workflowsPath, workflowId);

      const exists = yield* fs.exists(filePath);
      if (exists) {
        yield* fs.remove(filePath);
      }

      // TODO: Delete from database
      // yield* deleteFromDatabase(workflowId);
    }).pipe(Effect.mapError(wrapStorageError("delete", "DELETE_FAILED")));

  const exists: WorkflowStorageShape["exists"] = (workflowId) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;
      const filePath = yield* resolveWorkflowPath(workflowsPath, workflowId);
      return yield* fs.exists(filePath);
    }).pipe(Effect.orElseSucceed(() => false));

  return WorkflowStorage.of({
    save,
    load,
    list,
    delete: deleteWorkflow,
    exists,
  });
});

export const WorkflowStorageLive = Layer.effect(WorkflowStorage, makeWorkflowStorage);
