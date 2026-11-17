// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Alchemy modifications: uses Effect Schema instead of Zod and Array<T> syntax for non-tuple arrays,
// and resolves Workflow storage paths from the Engine namespace uniqueKey used by cloudflare-runtime.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ms } from "itty-time";
import type {
  DatabaseInstance,
  DatabaseVersion,
  DatabaseWorkflow,
  Engine,
  EngineLogs,
} from "./engine.ts";
import { InstanceEvent, instanceStatusName } from "./instance.ts";
import type { InstanceStatus as EngineInstanceStatus } from "./instance.ts";
import {
  duplicateInstanceError,
  isUserTriggeredDelete,
  isUserTriggeredPause,
  isUserTriggeredRestart,
  createWorkflowError,
  isUserTriggeredTerminate,
  WorkflowError,
} from "./lib/errors.ts";
import {
  isValidAddressableWorkflowInstanceId,
  isValidWorkflowInstanceId,
} from "./lib/validators.ts";
import { parseWorkflowSubscriptionOptions } from "./subscription.ts";
import type { WorkflowSubscription, WorkflowSubscriptionOptions } from "./subscription.ts";
import type {
  WorkflowInstanceModifier,
  WorkflowIntrospectionOperation,
  WorkflowIntrospectionStreamResult,
} from "./types.ts";

type Env = {
  ENGINE: DurableObjectNamespace<Engine>;
  BINDING_NAME: string;
  WORKFLOW_NAME: string;
  WORKFLOW_STORAGE?: Fetcher;
};

const STORAGE_DELETE_RETRY_INTERVAL_MS = 50;
const STORAGE_DELETE_RETRY_BUDGET_MS = 2_000;
const STORAGE_DELETE_MAX_RETRIES =
  STORAGE_DELETE_RETRY_BUDGET_MS / STORAGE_DELETE_RETRY_INTERVAL_MS;

const pendingDeletes = new Map<string, Promise<boolean>>();

function getStorageUrl(workflowName: string, hexId: string): string {
  if (/[\\/]/.test(workflowName) || workflowName.includes("\0") || !/^[a-f0-9]{64}$/i.test(hexId)) {
    throw new Error("Invalid Workflow storage path");
  }
  // Alchemy modification: the Engine namespace's uniqueKey (and so its
  // directory on disk) is `encodeURIComponent(workflowName)`, not Miniflare's
  // `miniflare-workflows-${workflowName}`.
  return `http://disk/${encodeURIComponent(encodeURIComponent(workflowName))}/${hexId}`;
}

async function removeFile(disk: Fetcher, url: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let isDirectory = false;
    try {
      const file = await disk.fetch(url, { method: "HEAD" });
      if (file.status === 404) {
        return false;
      }
      if (file.ok && file.headers.get("Content-Type") !== "application/octet-stream") {
        isDirectory = true;
      } else if (file.ok) {
        const response = await disk.fetch(url, { method: "DELETE" });
        if (response.ok || response.status === 404) {
          return response.ok;
        }
      }
    } catch (error) {
      if (attempt === STORAGE_DELETE_MAX_RETRIES) {
        throw error;
      }
    }
    if (isDirectory) {
      throw new Error("Refusing to delete a Workflow storage directory");
    }
    if (attempt === STORAGE_DELETE_MAX_RETRIES) {
      throw new Error("Failed to delete Workflow storage file");
    }
    await scheduler.wait(STORAGE_DELETE_RETRY_INTERVAL_MS);
  }
}

async function deleteWorkflowStorageFiles(
  disk: Fetcher,
  url: string,
  deleted = false,
): Promise<boolean> {
  let failure: unknown;
  for (const extension of [".sqlite", ".sqlite-shm", ".sqlite-wal"]) {
    try {
      const removed = await removeFile(disk, url + extension);
      deleted ||= extension === ".sqlite" && removed;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  return deleted;
}

/** Aborts local execution and serializes file cleanup with reuse of the same ID. */
export function deleteWorkflowStorage({
  disk,
  workflowName,
  ctx,
  hexId,
  abort,
  abortOnlyIfPersisted = false,
}: {
  disk?: Fetcher;
  workflowName: string;
  ctx: ExecutionContext;
  hexId: string;
  abort: () => Promise<void>;
  abortOnlyIfPersisted?: boolean;
}): Promise<boolean> {
  if (disk === undefined) {
    return abort().then(() => false);
  }
  const url = getStorageUrl(workflowName, hexId);
  const previous = pendingDeletes.get(url);
  const readyToDelete = (previous ?? Promise.resolve(false))
    .catch(() => false)
    .then(async (deleted) => {
      if (
        !abortOnlyIfPersisted ||
        (await disk.fetch(url + ".sqlite", { method: "HEAD" })).status !== 404
      ) {
        await abort();
        await scheduler.wait(100);
      }
      return deleted;
    });
  const cleanup = readyToDelete.then((deleted) => deleteWorkflowStorageFiles(disk, url, deleted));
  const pendingDelete = readyToDelete.then(
    () => cleanup,
    () => previous ?? false,
  );
  pendingDeletes.set(url, pendingDelete);
  ctx.waitUntil(
    pendingDelete.then(
      () => {
        if (pendingDeletes.get(url) === pendingDelete) {
          pendingDeletes.delete(url);
        }
      },
      () => {},
    ),
  );
  return cleanup;
}

/** Waits for queued file cleanup, retrying a failed cleanup once before reuse. */
async function waitForPersistedInstanceDelete(env: Env, id: string | undefined): Promise<void> {
  if (id === undefined || env.WORKFLOW_STORAGE === undefined) {
    return;
  }

  const hexId = env.ENGINE.idFromName(id).toString();
  const url = getStorageUrl(env.WORKFLOW_NAME, hexId);
  let retried = false;
  let pending = pendingDeletes.get(url);
  while (pending !== undefined) {
    try {
      await pending;
    } catch (error) {
      if (pendingDeletes.get(url) === pending) {
        if (retried) {
          throw error;
        }
        retried = true;
        pendingDeletes.set(url, deleteWorkflowStorageFiles(env.WORKFLOW_STORAGE, url));
      }
    }
    const latest = pendingDeletes.get(url);
    if (latest === pending) {
      pendingDeletes.delete(url);
      return;
    }
    pending = latest;
  }
}

/** Aborts an Engine object before removing its persistence files. */
async function deletePersistedInstance(env: Env, ctx: ExecutionContext, id: string): Promise<void> {
  if (env.WORKFLOW_STORAGE === undefined) {
    return;
  }

  const stub = env.ENGINE.get(env.ENGINE.idFromName(id));
  await deleteWorkflowStorage({
    disk: env.WORKFLOW_STORAGE,
    workflowName: env.WORKFLOW_NAME,
    ctx,
    hexId: stub.id.toString(),
    abort: async () => {
      try {
        await stub.unsafeAbort();
      } catch {
        // Aborting the Durable Object rejects its RPC.
      }
    },
  });
}

type WorkflowIntrospectionSession = {
  id: string;
  operations: Array<WorkflowIntrospectionOperation>;
  instanceIds: Array<string>;
};

// workerd may construct a fresh WorkflowBinding object for each RPC call. Store
// sessions at module scope so start/modify/get/dispose calls, and later
// WorkflowBinding.create() calls, all see the same active Workflow session.
const workflowIntrospectionSessions = new Map<string, WorkflowIntrospectionSession>();

function getWorkflowIntrospectionSession(
  workflowName: string,
  sessionId: string,
): WorkflowIntrospectionSession {
  const session = workflowIntrospectionSessions.get(workflowName);
  if (session?.id !== sessionId) {
    throw new Error(
      `Workflow ${JSON.stringify(workflowName)} does not have an active introspection session for this introspector.`,
    );
  }
  return session;
}

function isWorkflowIntrospectionStreamResult(
  value: unknown,
): value is WorkflowIntrospectionStreamResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "__workflowIntrospectionStreamResult" in value &&
    "chunks" in value &&
    value.__workflowIntrospectionStreamResult === true &&
    Array.isArray(value.chunks)
  );
}

function createWorkflowIntrospectionReadableStream(
  result: WorkflowIntrospectionStreamResult,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of result.chunks) {
        controller.enqueue(chunk.slice());
      }
      controller.close();
    },
  });
}

async function applyWorkflowIntrospectionOperation(
  modifier: WorkflowInstanceModifier,
  operation: WorkflowIntrospectionOperation,
) {
  switch (operation.type) {
    case "disableSleeps":
      await modifier.disableSleeps(operation.steps);
      break;
    case "disableRetryDelays":
      await modifier.disableRetryDelays(operation.steps);
      break;
    case "mockStepResult":
      await modifier.mockStepResult(
        operation.step,
        isWorkflowIntrospectionStreamResult(operation.stepResult)
          ? createWorkflowIntrospectionReadableStream(operation.stepResult)
          : operation.stepResult,
      );
      break;
    case "mockStepError": {
      const error = new Error(operation.error.message);
      error.name = operation.error.name;
      await modifier.mockStepError(operation.step, error, operation.times);
      break;
    }
    case "forceStepTimeout":
      await modifier.forceStepTimeout(operation.step, operation.times);
      break;
    case "mockEvent":
      await modifier.mockEvent(operation.event);
      break;
    case "forceEventTimeout":
      await modifier.forceEventTimeout(operation.step);
      break;
  }
}

// TODO(vaish): import from @cloudflare/workers-types once restart options are published
export interface RestartFromStep {
  name: string;
  count?: number;
  type?: "do" | "sleep" | "waitForEvent";
}

export interface WorkflowInstanceTerminateOptions {
  /**
   * If true, run registered rollback handlers before terminating the instance.
   */
  rollback?: boolean;
}

export interface WorkflowInstanceRestartOptions {
  from?: RestartFromStep;
}

export type WorkflowBatchCreateOptions =
  | {
      count: number;
      params?: unknown;
      retention?: WorkflowInstanceCreateOptions<unknown>["retention"];
      locationHint?: WorkflowInstanceCreateOptions<unknown>["locationHint"];
      instances?: never;
    }
  | {
      instances: WorkflowInstanceCreateOptions<unknown>[];
      count?: never;
      params?: never;
      retention?: never;
      locationHint?: never;
    };

export type WorkflowBatchCreateResult = {
  created: { id: string }[];
  errors: {
    index: number;
    id?: string;
    code: number;
    message: string;
  }[];
};

// Numeric durations are whole milliseconds; both forms must be positive. A
// single refinement keeps one error message for every invalid duration.
const retentionDurationSchema = Schema.Union([Schema.Number, Schema.String]).check(
  Schema.makeFilter(
    (value) => {
      if (typeof value === "number") return Number.isInteger(value) && value > 0;
      try {
        const duration = ms(value);
        return Number.isFinite(duration) && duration > 0;
      } catch {
        return false;
      }
    },
    {
      message:
        "Duration must be a number or a string in format '{{number}} {{unit}}' where unit is second(s), minute(s), etc.",
    },
  ),
);
const workflowInstanceCreateOptionsSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  retention: Schema.optional(
    Schema.Struct({
      successRetention: Schema.optional(retentionDurationSchema),
      errorRetention: Schema.optional(retentionDurationSchema),
    }),
  ),
  locationHint: Schema.optional(
    Schema.Literals([
      "wnam",
      "weur",
      "enam",
      "eeur",
      "apac",
      "apac-ne",
      "apac-se",
      "oc",
      "sam",
      "afr",
      "me",
    ]),
  ),
});

// this.env.WORKFLOW is WorkflowBinding
export class WorkflowBinding extends WorkerEntrypoint<Env> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
  }

  async #instanceExists(id: string): Promise<boolean> {
    // Avoid recreating the engine while its previous persistence is being deleted.
    await waitForPersistedInstanceDelete(this.env, id);
    const stub = this.env.ENGINE.get(this.env.ENGINE.idFromName(id));
    return await stub.hasInstance();
  }

  public async create(options: WorkflowInstanceCreateOptions = {}): Promise<{
    id: string;
  }> {
    // Destructuring defaults apply only to absent fields: an explicit null
    // id must reach the validation below rather than becoming a generated
    // id.
    const { id = crypto.randomUUID() } = options;
    if (!isValidWorkflowInstanceId(id)) {
      throw new WorkflowError("Workflow instance has invalid id");
    }

    // Deterministic (caller-provided) ids carry a documented uniqueness
    // contract: creating an instance with an id that already exists throws
    // and the existing instance is retained. The existence marker is
    // committed by the engine's init(), dispatched fire-and-forget below,
    // so duplicate creates racing ahead of that commit can all resolve
    // successfully; the engine's init() guards make the extra dispatch a
    // no-op, so the race cannot double-execute the workflow body.
    if (options.id !== undefined && (await this.#instanceExists(id))) {
      throw duplicateInstanceError(id);
    }

    return this.#createUnchecked(id, options);
  }

  // Creation body shared by create() and createBatch(), which perform their
  // own validation and existence checks before calling this.
  async #createUnchecked(
    id: string,
    options: WorkflowInstanceCreateOptions,
  ): Promise<{ id: string }> {
    const { params = {} } = options;
    if (options.id === undefined) {
      await waitForPersistedInstanceDelete(this.env, id);
    }
    const stubId = this.env.ENGINE.idFromName(id);
    const stub = this.env.ENGINE.get(stubId);
    const introspectionSession = workflowIntrospectionSessions.get(this.env.WORKFLOW_NAME);

    if (introspectionSession !== undefined) {
      using modifier = await stub.getInstanceModifier();
      introspectionSession.instanceIds.push(id);
      for (const operation of introspectionSession.operations) {
        await applyWorkflowIntrospectionOperation(modifier, operation);
      }
    }

    const now = new Date().toISOString();
    const initPromise = stub
      .init(
        0, // accountId: number,
        {} as DatabaseWorkflow, // workflow: DatabaseWorkflow,
        {} as DatabaseVersion, // version: DatabaseVersion,
        {
          id,
          created_on: now,
          modified_on: now,
          workflow_id: "",
          version_id: "",
          status: 0, // InstanceStatus.Queued
          started_on: now,
          ended_on: null,
        } satisfies DatabaseInstance,
        {
          timestamp: new Date(),
          payload: params as Readonly<typeof params>,
          instanceId: id,
          workflowName: this.env.WORKFLOW_NAME,
        },
      )
      .then((val) => {
        if (val !== undefined) {
          val[Symbol.dispose]();
        }
      })
      .catch(() => {
        // Suppress all rejections: create() should queue and
        // return immediately
      });

    this.ctx.waitUntil(initPromise);

    return {
      id,
    };
  }

  public async get(id: string): Promise<WorkflowInstance> {
    const stubId = this.env.ENGINE.idFromName(id);
    const stub = this.env.ENGINE.get(stubId);

    // Pass a getter function so WorkflowHandle can get a fresh stub after abort
    const getStub = () => this.env.ENGINE.get(this.env.ENGINE.idFromName(id));

    const handle = new WorkflowHandle(id, stub, getStub, this);

    try {
      await handle.status();
    } catch {
      throw new Error("instance.not_found");
    }

    return handle;
  }

  // A Workflow on `ctx.exports` is built by workerd's
  // `cloudflare-internal:workflows-api`, which addresses each instance by id
  // on the binding rather than calling the instance returned by `get()`. Each
  // method goes through `get()` so a missing instance still fails with
  // `instance.not_found`.

  public async getInstance(id: string): Promise<{ id: string }> {
    await this.get(id);
    return { id };
  }

  public async pause(id: string): Promise<void> {
    await (await this.get(id)).pause();
  }

  public async resume(id: string): Promise<void> {
    await (await this.get(id)).resume();
  }

  public async terminate(id: string, options?: WorkflowInstanceTerminateOptions): Promise<void> {
    await (await this.get(id)).terminate(options);
  }

  public async restart(id: string, options?: WorkflowInstanceRestartOptions): Promise<void> {
    await (await this.get(id)).restart(options);
  }

  public async status(id: string): Promise<InstanceStatus> {
    return await (await this.get(id)).status();
  }

  public async sendEvent(id: string, event: { type: string; payload: unknown }): Promise<void> {
    await (await this.get(id)).sendEvent(event);
  }

  public async subscribe(
    id: string,
    options?: WorkflowInstanceSubscribeOptions,
  ): Promise<WorkflowInstanceSubscription> {
    return await (await this.get(id)).subscribe(options);
  }

  public async createBatch(
    batch: WorkflowInstanceCreateOptions<unknown>[],
  ): Promise<{ id: string }[]>;
  public async createBatch(options: WorkflowBatchCreateOptions): Promise<WorkflowBatchCreateResult>;
  public async createBatch(
    options: WorkflowInstanceCreateOptions<unknown>[] | WorkflowBatchCreateOptions,
  ): Promise<{ id: string }[] | WorkflowBatchCreateResult> {
    const isLegacyBatch = Array.isArray(options);
    let batch: WorkflowInstanceCreateOptions<unknown>[];
    if (isLegacyBatch) {
      batch = options;
    } else if (options !== null && typeof options === "object") {
      if ("count" in options && options.count !== undefined) {
        if (!Number.isInteger(options.count) || options.count <= 0) {
          throw createWorkflowError("count must be a positive integer", "body");
        }
        if (options.count > 100) {
          throw createWorkflowError("batchCreate only supports 100 instances at a time", "body");
        }
        batch = Array.from({ length: options.count }, () => ({
          params: options.params,
          retention: options.retention,
          locationHint: options.locationHint,
        }));
      } else if ("instances" in options && Array.isArray(options.instances)) {
        batch = options.instances;
      } else {
        throw createWorkflowError("Provided argument is invalid", "body");
      }
    } else {
      throw createWorkflowError("Provided argument is invalid", "body");
    }

    if (batch.length === 0) {
      if (!isLegacyBatch) {
        throw createWorkflowError("Batch size exceeds maximum allowed", "body");
      }
      throw new Error("WorkflowError: batchCreate should have at least 1 instance");
    }
    if (batch.length > 100) {
      if (!isLegacyBatch) {
        throw createWorkflowError("Batch size exceeds maximum allowed", "body");
      }
      throw new Error("WorkflowError: batchCreate only supports 100 instances at a time");
    }

    // Validate only object-form entries before probing ids, which persists storage;
    // the deprecated array form retains create()'s option validation behavior.
    for (const instanceOptions of batch) {
      if (!isLegacyBatch) {
        const validation = Schema.decodeResult(workflowInstanceCreateOptionsSchema)(
          instanceOptions,
        );
        if (Result.isFailure(validation)) {
          throw createWorkflowError(validation.failure.message, "body");
        }
      }
      // Reserved ids are only rejected by the object form; the deprecated
      // array form keeps accepting every id that create() accepts.
      if (
        instanceOptions.id !== undefined &&
        (!isValidWorkflowInstanceId(instanceOptions.id) ||
          (!isLegacyBatch &&
            (["batch", "terminate", "terminateAll"].includes(instanceOptions.id) ||
              /^cf_[0-9a-f]{64}$/.test(instanceOptions.id))))
      ) {
        if (isLegacyBatch) {
          throw new WorkflowError("Workflow instance has invalid id");
        }
        throw createWorkflowError("Instance ID is invalid", "instance.invalid_id");
      }
    }

    // Probe each distinct caller-provided id once, concurrently, instead of
    // sequentially per entry (and a second time inside create()).
    const providedIds = [
      ...new Set(
        batch
          .map((instanceOptions) => instanceOptions.id)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const existing = new Set<string>();
    await Promise.all(
      providedIds.map(async (id) => {
        if (await this.#instanceExists(id)) {
          existing.add(id);
        }
      }),
    );

    // Existing and repeated ids are excluded from the created instances. The
    // legacy form omits them, while the object form reports their input indexes.
    const result: WorkflowBatchCreateResult = { created: [], errors: [] };
    const seenIds = new Set<string>();
    for (const [index, instanceOptions] of batch.entries()) {
      if (instanceOptions.id !== undefined) {
        if (seenIds.has(instanceOptions.id)) {
          if (!isLegacyBatch) {
            result.errors.push({
              index,
              id: instanceOptions.id,
              code: 10415,
              message: "workflows.api.error.instance.duplicate_in_batch",
            });
          }
          continue;
        }
        seenIds.add(instanceOptions.id);
        if (existing.has(instanceOptions.id)) {
          if (!isLegacyBatch) {
            result.errors.push({
              index,
              id: instanceOptions.id,
              code: 10405,
              message: "workflows.api.error.instance.already_exists",
            });
          }
          continue;
        }
      }
      const { id = crypto.randomUUID() } = instanceOptions;
      result.created.push(await this.#createUnchecked(id, instanceOptions));
    }
    return isLegacyBatch ? result.created : result;
  }

  /**
   * Deletes an instance. Named `deleteInstance` because `Fetcher.delete()` shadows
   * a same-named JSRPC method.
   */
  public async deleteInstance(id: string): Promise<void> {
    if (!isValidAddressableWorkflowInstanceId(id)) {
      throw createWorkflowError("Instance ID is invalid", "instance.invalid_id");
    }

    const stub = this.env.ENGINE.get(this.env.ENGINE.idFromName(id));
    await deleteWorkflowStorage({
      disk: this.env.WORKFLOW_STORAGE,
      workflowName: this.env.WORKFLOW_NAME,
      ctx: this.ctx,
      hexId: stub.id.toString(),
      abort: async () => {
        try {
          await stub.deleteInstance();
        } catch (error) {
          // delete aborts the instance
          if (!isUserTriggeredDelete(error)) {
            throw error;
          }
        }
      },
    });
  }

  /** Removes local persistence by hex ID, including orphaned instances in Explorer. */
  public async unsafeDeletePersistedInstance(hexId: string): Promise<boolean> {
    if (this.env.WORKFLOW_STORAGE === undefined) {
      throw new Error("Workflow storage service not available");
    }
    return deleteWorkflowStorage({
      disk: this.env.WORKFLOW_STORAGE,
      workflowName: this.env.WORKFLOW_NAME,
      ctx: this.ctx,
      hexId,
      abort: async () => {
        try {
          const stub = this.env.ENGINE.get(this.env.ENGINE.idFromString(hexId));
          await stub.unsafeAbort();
        } catch {}
      },
      abortOnlyIfPersisted: true,
    });
  }

  /** Deletes each unique instance once while preserving duplicate results. */
  public async deleteBatch(options: {
    instances: Array<string>;
  }): Promise<WorkflowBatchDeleteResult> {
    const instanceIds = options?.instances;
    if (!Array.isArray(instanceIds)) {
      throw createWorkflowError("Provided argument is invalid", "body");
    }
    if (instanceIds.length > 100) {
      throw createWorkflowError(
        "batchDeleteInstances only supports 100 instances at a time",
        "body",
      );
    }
    if (instanceIds.length === 0) {
      throw createWorkflowError("batchDeleteInstances should have at least 1 instance", "body");
    }
    if (!instanceIds.every(isValidAddressableWorkflowInstanceId)) {
      throw createWorkflowError("Instance ID is invalid", "instance.invalid_id");
    }

    const uniqueIds = [...new Set(instanceIds)];
    const settled = await Promise.allSettled(uniqueIds.map((id) => this.deleteInstance(id)));
    const resultsById = new Map(uniqueIds.map((id, index) => [id, settled[index]]));
    const result: WorkflowBatchDeleteResult = { deleted: [], errors: [] };
    for (const id of instanceIds) {
      const deletion = resultsById.get(id);
      if (deletion === undefined) {
        throw new Error("Missing batch deletion result");
      }
      if (deletion.status === "fulfilled" || isUserTriggeredDelete(deletion.reason)) {
        result.deleted.push({ id });
        continue;
      }

      const isNotFound =
        deletion.reason instanceof Error &&
        deletion.reason.message.includes("(instance.not_found)");
      result.errors.push({
        id,
        code: isNotFound ? 10400 : 10001,
        message: isNotFound
          ? "workflows.api.error.instance.not_found"
          : "workflows.api.error.internal_server",
      });
    }

    const missingIds = new Set(
      result.errors.filter(({ code }) => code === 10400).map(({ id }) => id),
    );
    const cleanupIds = [...missingIds];
    const cleanups = await Promise.allSettled(
      cleanupIds.map((id) => deletePersistedInstance(this.env, this.ctx, id)),
    );
    const failedCleanupIds = new Set(
      cleanupIds.filter((_, index) => cleanups[index]?.status === "rejected"),
    );
    if (failedCleanupIds.size === 0) {
      return result;
    }

    const errorsById = new Map(result.errors.map((error) => [error.id, error]));
    return {
      deleted: result.deleted.filter(({ id }) => !failedCleanupIds.has(id)),
      errors: instanceIds.flatMap((id) => {
        if (failedCleanupIds.has(id)) {
          return [{ id, code: 10001, message: "workflows.api.error.internal_server" }];
        }
        const error = errorsById.get(id);
        return error === undefined ? [] : [error];
      }),
    };
  }

  public async unsafeGetBindingName(): Promise<string> {
    // async because of rpc
    return this.env.BINDING_NAME;
  }

  public async unsafeStartIntrospection(): Promise<string> {
    if (workflowIntrospectionSessions.has(this.env.WORKFLOW_NAME)) {
      throw new Error(
        `Workflow ${JSON.stringify(this.env.WORKFLOW_NAME)} already has an active introspection session for binding ${JSON.stringify(this.env.BINDING_NAME)}.`,
      );
    }

    const sessionId = crypto.randomUUID();
    workflowIntrospectionSessions.set(this.env.WORKFLOW_NAME, {
      id: sessionId,
      operations: [],
      instanceIds: [],
    });
    return sessionId;
  }

  public async unsafeStopIntrospection(sessionId: string): Promise<void> {
    const session = workflowIntrospectionSessions.get(this.env.WORKFLOW_NAME);
    if (session?.id === sessionId) {
      workflowIntrospectionSessions.delete(this.env.WORKFLOW_NAME);
    }
  }

  public async unsafeSetIntrospectionOperations(
    sessionId: string,
    operations: Array<WorkflowIntrospectionOperation>,
  ): Promise<void> {
    const session = getWorkflowIntrospectionSession(this.env.WORKFLOW_NAME, sessionId);
    session.operations = operations;
  }

  public async unsafeGetIntrospectionInstances(sessionId: string): Promise<Array<string>> {
    return getWorkflowIntrospectionSession(this.env.WORKFLOW_NAME, sessionId).instanceIds;
  }

  public async unsafeGetInstanceModifier(instanceId: string): Promise<unknown> {
    // async because of rpc
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);

    const instanceModifier = stub.getInstanceModifier();

    return instanceModifier;
  }

  public async unsafeWaitForStepResult(
    instanceId: string,
    name: string,
    index?: number,
  ): Promise<unknown> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);

    return stub.waitForStepResult(name, index);
  }

  public async unsafeAbort(instanceId: string, reason?: string): Promise<void> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);

    try {
      await stub.unsafeAbort(reason);
    } catch {
      // do nothing because we want to dispose this instance
    }
  }

  public async unsafeWaitForStatus(instanceId: string, status: string): Promise<void> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);
    return await stub.waitForStatus(status);
  }

  public async unsafeGetOutputOrError(instanceId: string, isOutput: boolean): Promise<unknown> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);
    return stub.getOutputOrError(isOutput);
  }
}

export class WorkflowHandle extends RpcTarget implements WorkflowInstance {
  private stub: DurableObjectStub<Engine>;

  constructor(
    public id: string,
    stub: DurableObjectStub<Engine>,
    private getStub: () => DurableObjectStub<Engine>,
    private binding: WorkflowBinding,
  ) {
    super();
    this.stub = stub;
  }

  public async pause(): Promise<void> {
    try {
      await this.stub.changeInstanceStatus("pause");
    } catch (e) {
      // pause causes instance abortion
      if (!isUserTriggeredPause(e)) {
        throw e;
      }
    }
  }

  public async resume(): Promise<void> {
    await this.stub.changeInstanceStatus("resume");
  }

  public async terminate(options?: WorkflowInstanceTerminateOptions): Promise<void> {
    try {
      await this.stub.changeInstanceStatus("terminate", undefined, options);
    } catch (e) {
      // terminate causes instance abortion
      if (!isUserTriggeredTerminate(e)) {
        throw e;
      }
    }
  }

  public async delete(): Promise<void> {
    await this.binding.deleteInstance(this.id);
  }

  public async restart(options?: WorkflowInstanceRestartOptions): Promise<void> {
    try {
      await this.stub.changeInstanceStatus("restart", options?.from);
    } catch (e) {
      // restart causes instance abortion
      if (!isUserTriggeredRestart(e)) {
        throw e;
      }
    }

    // trigger restart flow after abortion
    this.stub = this.getStub();
    await this.stub.attemptRestart();
  }

  public async status(): Promise<InstanceStatus & { __LOCAL_DEV_STEP_OUTPUTS: Array<unknown> }> {
    // Both getStatus() and readLogs() must use the same fresh stub.
    // After pause/restart/terminate aborts the DO, the stub goes stale
    const fetchStatusAndLogs = async () => {
      const status = await this.stub.getStatus();

      // NOTE(lduarte): for some reason, sync functions over RPC are typed as never instead of Promise<EngineLogs>
      const logs = await (this.stub.readLogs() as unknown as Promise<EngineLogs & Disposable>);

      return { status, logs };
    };

    let result: {
      status: EngineInstanceStatus;
      logs: EngineLogs & Disposable;
    };
    try {
      result = await fetchStatusAndLogs();
    } catch {
      this.stub = this.getStub();
      result = await fetchStatusAndLogs();
    }
    // Dispose the RPC handle when the method scope exits
    using logs = result.logs;

    const filteredLogs = logs.logs.filter(
      (log) =>
        log.event === InstanceEvent.STEP_SUCCESS || log.event === InstanceEvent.WAIT_COMPLETE,
    );

    const stepOutputs = filteredLogs.map((log) =>
      log.event === InstanceEvent.STEP_SUCCESS ? log.metadata.result : log.metadata.payload,
    );

    const workflowOutput =
      logs.logs.find((log) => log.event === InstanceEvent.WORKFLOW_SUCCESS)?.metadata.result ??
      null;

    const workflowError = logs.logs.find((log) => log.event === InstanceEvent.WORKFLOW_FAILURE)
      ?.metadata.error;

    return {
      status: instanceStatusName(result.status),
      __LOCAL_DEV_STEP_OUTPUTS: stepOutputs,
      output: workflowOutput,
      error: workflowError,
    };
  }

  public async subscribe(options?: WorkflowSubscriptionOptions): Promise<WorkflowSubscription> {
    const parsedOptions = parseWorkflowSubscriptionOptions(options);
    return this.stub.subscribe(parsedOptions);
  }

  public async sendEvent(args: { payload: unknown; type: string }): Promise<void> {
    await this.stub.receiveEvent({
      payload: args.payload,
      type: args.type,
      timestamp: new Date(),
    });
  }
}
