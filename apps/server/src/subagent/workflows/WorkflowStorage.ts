/**
 * WorkflowStorage - Dual storage (filesystem + database) for workflows.
 *
 * Primary: Filesystem at .claude/workflows/
 * Backup: Database table for redundancy
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { WorkflowDefinition, WorkflowMetadata } from "./WorkflowSchema.ts";

export class WorkflowStorageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowStorageError";
  }
}

export interface WorkflowFilter {
  readonly name?: string;
  readonly version?: string;
}

export interface WorkflowStorageShape {
  readonly save: (
    workflow: WorkflowDefinition,
    metadata?: Partial<WorkflowMetadata>,
  ) => Effect.Effect<string, WorkflowStorageError>;

  readonly load: (workflowId: string) => Effect.Effect<WorkflowDefinition, WorkflowStorageError>;

  readonly list: (
    filter?: WorkflowFilter,
  ) => Effect.Effect<ReadonlyArray<WorkflowMetadata>, WorkflowStorageError>;

  readonly delete: (workflowId: string) => Effect.Effect<void, WorkflowStorageError>;

  readonly exists: (workflowId: string) => Effect.Effect<boolean>;
}

export class WorkflowStorage extends Context.Service<WorkflowStorage, WorkflowStorageShape>()(
  "t3/subagent/WorkflowStorage",
) {}

const WORKFLOWS_DIR = ".claude/workflows";

const makeWorkflowStorage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Ensure workflows directory exists
  const ensureDir = Effect.gen(function* () {
    const workflowsPath = path.join(process.cwd(), WORKFLOWS_DIR);
    const exists = yield* fs.exists(workflowsPath);
    if (!exists) {
      yield* fs.makeDirectory(workflowsPath, { recursive: true });
    }
    return workflowsPath;
  });

  const save: WorkflowStorageShape["save"] = (workflow, metadata) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;

      // Generate ID from name + version
      const workflowId = `${workflow.name.toLowerCase().replace(/\s+/g, "-")}-${workflow.version}`;
      const filePath = path.join(workflowsPath, `${workflowId}.json`);

      const now = new Date().toISOString();
      const fullMetadata: WorkflowMetadata = {
        id: workflowId,
        name: workflow.name,
        version: workflow.version,
        description: workflow.description,
        createdAt: metadata?.createdAt ?? now,
        updatedAt: now,
      };

      const fileContent = JSON.stringify(
        {
          metadata: fullMetadata,
          workflow,
        },
        null,
        2,
      );

      yield* fs.writeFileString(filePath, fileContent);

      // TODO: Sync to database as backup
      // yield* syncToDatabase(workflowId, workflow, fullMetadata);

      return workflowId;
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new WorkflowStorageError(
            `Failed to save workflow: ${error instanceof Error ? error.message : String(error)}`,
            "SAVE_FAILED",
          ),
        ),
      ),
    );

  const load: WorkflowStorageShape["load"] = (workflowId) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;
      const filePath = path.join(workflowsPath, `${workflowId}.json`);

      const exists = yield* fs.exists(filePath);
      if (!exists) {
        // Try to restore from database
        // const restored = yield* restoreFromDatabase(workflowId);
        // if (restored) return restored;

        return yield* Effect.fail(
          new WorkflowStorageError(`Workflow ${workflowId} not found`, "NOT_FOUND"),
        );
      }

      const content = yield* fs.readFileString(filePath);
      const parsed = JSON.parse(content);

      // Validate schema
      const decoded = yield* Schema.decodeUnknown(WorkflowDefinition)(parsed.workflow);
      return decoded;
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new WorkflowStorageError(
            `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`,
            "LOAD_FAILED",
          ),
        ),
      ),
    );

  const list: WorkflowStorageShape["list"] = (filter) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;

      const files = yield* fs.readDirectory(workflowsPath);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      const metadataList: WorkflowMetadata[] = [];

      for (const file of jsonFiles) {
        const filePath = path.join(workflowsPath, file);
        const content = yield* fs.readFileString(filePath);
        const parsed = JSON.parse(content);

        if (parsed.metadata) {
          const metadata = parsed.metadata as WorkflowMetadata;

          // Apply filters
          if (filter?.name && metadata.name !== filter.name) continue;
          if (filter?.version && metadata.version !== filter.version) continue;

          metadataList.push(metadata);
        }
      }

      return metadataList;
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new WorkflowStorageError(
            `Failed to list workflows: ${error instanceof Error ? error.message : String(error)}`,
            "LIST_FAILED",
          ),
        ),
      ),
    );

  const deleteWorkflow: WorkflowStorageShape["delete"] = (workflowId) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;
      const filePath = path.join(workflowsPath, `${workflowId}.json`);

      const exists = yield* fs.exists(filePath);
      if (exists) {
        yield* fs.remove(filePath);
      }

      // TODO: Delete from database
      // yield* deleteFromDatabase(workflowId);
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new WorkflowStorageError(
            `Failed to delete workflow: ${error instanceof Error ? error.message : String(error)}`,
            "DELETE_FAILED",
          ),
        ),
      ),
    );

  const exists: WorkflowStorageShape["exists"] = (workflowId) =>
    Effect.gen(function* () {
      const workflowsPath = yield* ensureDir;
      const filePath = path.join(workflowsPath, `${workflowId}.json`);
      return yield* fs.exists(filePath);
    }).pipe(Effect.orElse(() => Effect.succeed(false)));

  return WorkflowStorage.of({
    save,
    load,
    list,
    delete: deleteWorkflow,
    exists,
  });
});

export const WorkflowStorageLive = Layer.effect(WorkflowStorage, makeWorkflowStorage);
