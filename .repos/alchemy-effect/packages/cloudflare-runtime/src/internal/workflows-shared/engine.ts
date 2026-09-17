// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { DurableObject } from "cloudflare:workers";
import { Context } from "./context.ts";
import {
  INSTANCE_METADATA,
  InstanceEvent,
  InstanceStatus,
  instanceStatusName,
  InstanceTrigger,
  toInstanceStatus,
} from "./instance.ts";
import { computeHash } from "./lib/cache.ts";
import {
  ABORT_REASONS,
  createWorkflowError,
  isAbortError,
  PreservedNonRetryableError,
  shouldPreserveNonRetryableError,
  stepNotFoundError,
  WorkflowFatalError,
} from "./lib/errors.ts";
import {
  ENGINE_TIMEOUT,
  GracePeriodSemaphore,
  startGracePeriod,
} from "./lib/gracePeriodSemaphore.ts";
import {
  readAndClearRestartFromStep,
  resolveGroupKeysToWipe,
  storeRestartFromStep,
  wipeRestartState,
} from "./lib/restart.ts";
import { clearRollbackRegistry, executeRollbacks } from "./lib/rollback.ts";
import {
  createReplayReadableStream,
  getInvalidStoredStreamOutputError,
  getStoredStreamOutputPreview,
  StreamOutputState,
} from "./lib/streams.ts";
import { TimePriorityQueue } from "./lib/timePriorityQueue.ts";
import { MODIFIER_KEYS, WorkflowInstanceModifier } from "./modifier.ts";
import type { RestartFromStep } from "./binding.ts";
import type { Event } from "./context.ts";
import type { InstanceMetadata, RawInstanceLog } from "./instance.ts";
import type { RollbackRegistryEntry } from "./lib/rollback.ts";
import type { StreamOutputMeta } from "./lib/streams.ts";
import type {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";

interface Env {
  ENGINE: DurableObjectNamespace<Engine>;
  USER_WORKFLOW: WorkflowEntrypoint;
  STEP_LIMIT?: string; // JSON-encoded number from miniflare binding
}

export type DatabaseWorkflow = {
  name: string;
  id: string;
  created_on: string;
  modified_on: string;
  script_name: string;
  class_name: string | null;
  triggered_on: string | null;
};

export type DatabaseVersion = {
  id: string;
  class_name: string;
  created_on: string;
  modified_on: string;
  workflow_id: string;
  mutable_pipeline_id: string;
};

export type DatabaseInstance = {
  id: string;
  created_on: string;
  modified_on: string;
  workflow_id: string;
  version_id: string;
  status: InstanceStatus;
  started_on: string | null;
  ended_on: string | null;
};

export type Log = {
  event: InstanceEvent;
  group: string | null;
  target: string | null;
  metadata: {
    result: string;
    payload: string;
    error: { name: string; message: string };
  };
};

export type EngineLogs = {
  logs: Array<Log>;
};

const ENGINE_STATUS_KEY = "ENGINE_STATUS";

const EVENT_MAP_PREFIX = "EVENT_MAP";

export const DEFAULT_STEP_LIMIT = 10_000;

const PAUSE_DATETIME = "PAUSE_DATETIME";

/**
 * JSON.stringify replacer that converts TypedArrays and ArrayBuffers to a
 * human-readable description. Without this, JSON.stringify(Uint8Array) encodes
 * each byte as a numeric key ({"0":1,"1":2,...}), producing a string ~10x larger
 * than byteLength and causing SQLITE_TOOBIG for outputs above ~170 KB.
 * The replacer is called recursively by JSON.stringify, so nested binary values
 * inside objects or arrays are also handled.
 */
function binaryReplacer(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer(${value.byteLength} bytes)]`;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return `[${value.constructor.name}(${(value as ArrayBufferView).byteLength} bytes)]`;
  }
  return value;
}

function isStepSuccessEvent(event: InstanceEvent): boolean {
  return (
    event === InstanceEvent.STEP_SUCCESS ||
    event === InstanceEvent.ROLLBACK_STEP_SUCCESS
  );
}

export class Engine extends DurableObject<Env> {
  logs: Array<unknown> = [];

  isRunning: boolean = false;
  accountId: number | undefined;
  instanceId: string | undefined;
  workflowName: string | undefined;
  timeoutHandler: GracePeriodSemaphore;
  priorityQueue: TimePriorityQueue | undefined;
  stepLimit: number;
  engineAbortController: AbortController = new AbortController();
  pauseController: AbortController = new AbortController();

  waiters: Map<
    string,
    Array<
      [cacheKey: string, resolve: (event: Event | PromiseLike<Event>) => void]
    >
  > = new Map();
  eventMap: Map<string, Array<Event>> = new Map();

  // Not persisted: rollback fns are RPC stubs, dead across DO restarts.
  rollbackRegistry: Map<string, RollbackRegistryEntry> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    this.stepLimit = env.STEP_LIMIT
      ? JSON.parse(env.STEP_LIMIT)
      : DEFAULT_STEP_LIMIT;

    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        try {
          this.ctx.storage.sql.exec(`
						CREATE TABLE IF NOT EXISTS priority_queue (
							id INTEGER PRIMARY KEY NOT NULL,
							created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
							target_timestamp INTEGER NOT NULL,
							action INTEGER NOT NULL, -- should only be 0 or 1 (1 for added, 0 for deleted),
							entryType INTEGER NOT NULL,
							hash TEXT NOT NULL,
							CHECK (action IN (0, 1)), -- guararentee that action can only be 0 or 1
							UNIQUE (action, entryType, hash)
						);
				CREATE TABLE IF NOT EXISTS states (
					id INTEGER PRIMARY KEY NOT NULL,
					timestamp TIMESTAMP DEFAULT (DATETIME('now','subsec')),
					groupKey TEXT,
					target TEXT,
					metadata TEXT,
					event INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS streaming_step_chunks (
					cache_key TEXT NOT NULL,
					attempt INTEGER NOT NULL,
					chunk_index INTEGER NOT NULL,
					chunk BLOB NOT NULL,
					PRIMARY KEY (cache_key, attempt, chunk_index)
				) WITHOUT ROWID
				`);
        } catch (e) {
          console.error(e);
          throw e;
        }
      });
    });

    this.timeoutHandler = new GracePeriodSemaphore(
      startGracePeriod,
      ENGINE_TIMEOUT,
    );
  }

  writeLog(
    event: InstanceEvent,
    group: string | null,
    target: string | null = null,
    metadata: Record<string, unknown>,
  ) {
    this.ctx.storage.sql.exec(
      "INSERT INTO states (event, groupKey, target, metadata) VALUES (?, ?, ?, ?)",
      event,
      group,
      target,
      JSON.stringify(metadata, binaryReplacer),
    );

    // Wake any waiters if this is a terminal step event
    if (group) {
      this.handleStepResultWaiter(group, event, metadata);
    }
  }

  readStepStartGroupKeysDesc(): Array<string> {
    const rows = [
      ...this.ctx.storage.sql.exec<{ groupKey: string }>(
        "SELECT groupKey FROM states WHERE event = ? AND groupKey IS NOT NULL ORDER BY id DESC",
        InstanceEvent.STEP_START,
      ),
    ];
    return rows.map(({ groupKey }) => groupKey);
  }

  // Lives here for access to the protected DurableObject `ctx`.
  createRollbackContext(rollbackStep?: { cacheKey: string }): Context {
    return new Context(this, this.ctx, rollbackStep);
  }

  readLogsFromStep(_cacheKey: string): Array<RawInstanceLog> {
    return [];
  }

  readLogs(): EngineLogs {
    const logs = [
      ...this.ctx.storage.sql.exec<{
        event: InstanceEvent;
        groupKey: string | null;
        target: string | null;
        metadata: string;
      }>("SELECT event, groupKey, target, metadata FROM states"),
    ];

    return {
      logs: logs.map((log) => {
        const metadata = JSON.parse(log.metadata);

        if (!isStepSuccessEvent(log.event) || !metadata.streamOutput) {
          return { ...log, metadata, group: log.groupKey };
        }

        const { cacheKey, meta } = metadata.streamOutput as {
          cacheKey: string;
          meta: StreamOutputMeta;
        };
        try {
          const preview = getStoredStreamOutputPreview({
            storage: this.ctx.storage,
            cacheKey,
            meta,
            maxChars: 1024,
          });
          metadata.result =
            preview.type === "text"
              ? preview.output
              : `[ReadableStream (binary): ${meta.totalBytes} bytes]`;
        } catch {
          metadata.result = `[ReadableStream: ${meta.totalBytes} bytes]`;
        }
        delete metadata.streamOutput;

        return { ...log, metadata, group: log.groupKey };
      }),
    };
  }

  /**
   * Returns detailed logs including timestamps, ordered by ID.
   * Used by the local explorer to reconstruct step-level detail.
   */
  readDetailedLogs(): Array<{
    id: number;
    timestamp: string;
    event: number;
    group: string | null;
    target: string | null;
    metadata: Record<string, unknown>;
  }> {
    const rows = [
      ...this.ctx.storage.sql.exec<{
        id: number;
        timestamp: string;
        event: number;
        groupKey: string | null;
        target: string | null;
        metadata: string;
      }>(
        "SELECT id, timestamp, event, groupKey, target, metadata FROM states ORDER BY id ASC",
      ),
    ];

    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;

      if (!isStepSuccessEvent(row.event) || !metadata.streamOutput) {
        return {
          id: row.id,
          timestamp: String(row.timestamp).replace(" ", "T") + "Z",
          event: row.event,
          group: row.groupKey,
          target: row.target,
          metadata,
        };
      }

      const { cacheKey, meta } = metadata.streamOutput as {
        cacheKey: string;
        meta: StreamOutputMeta;
      };
      try {
        const preview = getStoredStreamOutputPreview({
          storage: this.ctx.storage,
          cacheKey,
          meta,
          maxChars: 1024,
        });
        metadata.result =
          preview.type === "text"
            ? preview.output
            : `[ReadableStream (binary): ${meta.totalBytes} bytes]`;
      } catch {
        metadata.result = `[ReadableStream: ${meta.totalBytes} bytes]`;
      }
      delete metadata.streamOutput;

      return {
        id: row.id,
        timestamp: String(row.timestamp).replace(" ", "T") + "Z",
        event: row.event,
        group: row.groupKey,
        target: row.target,
        metadata,
      };
    });
  }

  readLogsFromEvent(eventType: InstanceEvent): EngineLogs {
    const logs = [
      ...this.ctx.storage.sql.exec<{
        event: InstanceEvent;
        groupKey: string | null;
        target: string | null;
        metadata: string;
      }>(
        "SELECT event, groupKey, target, metadata FROM states WHERE event = ?",
        eventType,
      ),
    ];

    return {
      logs: logs.map((log) => ({
        ...log,
        metadata: JSON.parse(log.metadata),
        group: log.groupKey,
      })),
    };
  }

  async getStatus(): Promise<InstanceStatus> {
    if (this.accountId === undefined) {
      // Engine could have restarted, so we try to restore from its state
      const metadata =
        await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);
      if (metadata === undefined) {
        // metadata was never set, so we assume the engine was never started
        throw new Error("Engine was never started");
      }

      this.accountId = metadata.accountId;
      this.instanceId = metadata.instance.id;
      this.workflowName = metadata.workflow.name;
    }

    const res = await this.ctx.storage.get<InstanceStatus>(ENGINE_STATUS_KEY);

    // NOTE(lduarte): if status don't exist, means that engine is running for the first time, so we assume queued
    if (res === undefined) {
      return InstanceStatus.Queued;
    }
    return res;
  }

  // Returns instance metadata for the local explorer.
  async getInstanceMetadata(): Promise<{
    instanceId: string;
    status: InstanceStatus;
    createdOn: string;
  }> {
    const status = await this.getStatus();
    // Read the full metadata to get the created_on timestamp
    const metadata =
      await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);
    let createdOn = metadata?.instance?.created_on ?? "";

    // Backfill for instances created before created_on was populated:
    // try the earliest log entry, then the earliest priority queue entry.
    if (!createdOn) {
      const queries = [
        "SELECT timestamp AS ts FROM states ORDER BY id ASC LIMIT 1",
        "SELECT created_on AS ts FROM priority_queue ORDER BY id ASC LIMIT 1",
      ];
      for (const query of queries) {
        if (createdOn) {
          break;
        }
        try {
          for (const row of this.ctx.storage.sql.exec(query)) {
            if (row.ts) {
              // SQLite DATETIME('now','subsec') returns "YYYY-MM-DD HH:MM:SS.sss"
              // which is not valid ISO 8601 (needs T separator and Z timezone).
              const raw = String(row.ts).replace(" ", "T") + "Z";
              createdOn = raw;
            }
          }
        } catch {
          // Table may not exist
        }
      }
    }

    return {
      instanceId: this.instanceId ?? "",
      status,
      createdOn,
    };
  }

  async setStatus(
    accountId: number,
    instanceId: string,
    status: InstanceStatus,
  ): Promise<void> {
    await this.ctx.storage.put(ENGINE_STATUS_KEY, status);

    // check if anyone is waiting for this status
    this.handleStatusWaiter(status);
  }

  private statusWaiters: Map<
    InstanceStatus,
    { resolve: () => void; reject: (e: unknown) => void }
  > = new Map();
  async waitForStatus(status: string): Promise<void> {
    const targetStatus = toInstanceStatus(status);
    const currentStatus =
      await this.ctx.storage.get<InstanceStatus>(ENGINE_STATUS_KEY);

    // if the workflow has already reached the desired state, resolve immediately
    if (currentStatus === targetStatus) {
      return;
    }

    // if it hasn't reached the desired state, create a new promise and add its resolver to the waiters map
    return new Promise((resolve, reject) => {
      this.statusWaiters.set(targetStatus, { resolve, reject });
      // immediately reconcile against current status in case it's already finite
      this.handleStatusWaiter(currentStatus as InstanceStatus);
    });
  }

  handleStatusWaiter(status: InstanceStatus): void {
    const waiter = this.statusWaiters.get(status);

    // resolve if it reached the desired status
    if (waiter) {
      waiter.resolve();
      this.statusWaiters.delete(status);
      return;
    }

    switch (status) {
      case InstanceStatus.Errored: {
        // if it reaches final status "errored", then it can't be waiting for it to complete or terminate
        const unreachableStatuses = [
          InstanceStatus.Complete,
          InstanceStatus.Terminated,
        ];

        this.rejectUnreachableStatus(status, unreachableStatuses);
        break;
      }
      case InstanceStatus.Terminated: {
        // if it reaches final status "terminated", then it can't be waiting for it to complete or error
        const unreachableStatuses = [
          InstanceStatus.Complete,
          InstanceStatus.Errored,
        ];

        this.rejectUnreachableStatus(status, unreachableStatuses);
        break;
      }
      case InstanceStatus.Complete: {
        // if it reaches final status "complete", then it can't be waiting for it to terminate or error
        const unreachableStatuses = [
          InstanceStatus.Terminated,
          InstanceStatus.Errored,
        ];

        this.rejectUnreachableStatus(status, unreachableStatuses);
        break;
      }
      default:
        break;
    }
  }

  rejectUnreachableStatus(
    reachedStatus: number,
    unreachableStatuses: Array<number>,
  ): void {
    if (unreachableStatuses) {
      for (const unreachableStatus of unreachableStatuses) {
        const waiter = this.statusWaiters.get(unreachableStatus);
        if (waiter) {
          waiter.reject(
            new Error(
              `[WorkflowIntrospector] The Workflow instance ${
                this.instanceId
              } has reached status '${instanceStatusName(
                reachedStatus,
              )}'. This is a finite status that prevents it from ever reaching the expected status of '${instanceStatusName(
                unreachableStatus,
              )}'.`,
            ),
          );
          this.statusWaiters.delete(unreachableStatus);
          return;
        }
      }
    }
  }

  /**
   * Create a replay ReadableStream from stored stream output metadata.
   * Returns undefined if the stream data is not in a valid/complete state.
   */
  private replayStreamFromMeta(streamOutput: {
    cacheKey: string;
    meta: StreamOutputMeta;
  }): ReadableStream<Uint8Array> | undefined {
    if (streamOutput.meta.state !== StreamOutputState.Complete) {
      return undefined;
    }
    const integrityError = getInvalidStoredStreamOutputError(
      this.ctx.storage,
      streamOutput.cacheKey,
      streamOutput.meta,
    );
    if (integrityError !== undefined) {
      return undefined;
    }
    return createReplayReadableStream({
      storage: this.ctx.storage,
      cacheKey: streamOutput.cacheKey,
      meta: streamOutput.meta,
    });
  }

  private stepResultWaiters: Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  > = new Map();
  async waitForStepResult(
    stepName: string,
    stepCount?: number,
  ): Promise<unknown> {
    const hash = await computeHash(stepName);
    const count = stepCount ?? 1;
    const cacheKey = `${hash}-${count}`;

    // read latest log from step
    const rows = [
      ...this.ctx.storage.sql.exec<{
        event: InstanceEvent;
        metadata: string;
      }>(
        "SELECT event, metadata FROM states WHERE groupKey = ? ORDER BY id DESC LIMIT 1",
        cacheKey,
      ),
    ];

    if (rows.length > 0) {
      const { event, metadata } = rows[0];
      const parsed = JSON.parse(metadata);
      if (event === InstanceEvent.STEP_SUCCESS) {
        if (parsed?.streamOutput) {
          return this.replayStreamFromMeta(parsed.streamOutput);
        }
        return parsed?.result;
      }
      if (event === InstanceEvent.STEP_FAILURE) {
        throw parsed?.error ?? parsed;
      }
    }

    // if it hasn't completed the step, create a new promise to later resolve/reject
    return new Promise<unknown>((resolve, reject) => {
      this.stepResultWaiters.set(cacheKey, { resolve, reject });
    });
  }

  handleStepResultWaiter(
    group: string,
    event: InstanceEvent,
    metadata: Record<string, unknown>,
  ) {
    const waiter = this.stepResultWaiters.get(group);
    if (!waiter) {
      return;
    }
    if (event === InstanceEvent.STEP_SUCCESS) {
      if (metadata?.streamOutput) {
        waiter.resolve(
          this.replayStreamFromMeta(
            metadata.streamOutput as {
              cacheKey: string;
              meta: StreamOutputMeta;
            },
          ),
        );
      } else {
        waiter.resolve(metadata?.result);
      }
      this.stepResultWaiters.delete(group);
    } else if (event === InstanceEvent.STEP_FAILURE) {
      const error = metadata?.error ?? new Error("Step failed");
      waiter.reject(error);
      this.stepResultWaiters.delete(group);
    }
  }

  async getOutputOrError(isOutput: boolean): Promise<unknown> {
    const status = await this.getStatus();

    if (isOutput) {
      if (status !== InstanceStatus.Complete) {
        throw new Error(
          `Cannot retrieve output: Workflow instance is in status "${instanceStatusName(
            status,
          )}" but must be "complete" to have an output available`,
        );
      }
      const logs = this.readLogsFromEvent(InstanceEvent.WORKFLOW_SUCCESS).logs;
      return logs.at(0)?.metadata.result;
    } else {
      if (status !== InstanceStatus.Errored) {
        throw new Error(
          `Cannot retrieve error: Workflow instance is in status "${instanceStatusName(
            status,
          )}" but must be "errored" to have error information available`,
        );
      }
      const logs = this.readLogsFromEvent(InstanceEvent.WORKFLOW_FAILURE).logs;
      const log = logs.at(0);
      if (!log?.metadata.error) {
        throw new Error(
          "Cannot retrieve error: No workflow instance failure log found",
        );
      }
      return log.metadata.error;
    }
  }

  async abort(reason: string) {
    await this.ctx.storage.sync();

    // Clean up pending JS operations
    this.timeoutHandler.dispose();
    this.engineAbortController.abort(new Error(reason));

    this.ctx.abort(reason);
  }

  // Called by the dispose function when introspecting the instance in tests
  // TODO: Ideally this abort should be done by `abortAllDurableObjects` from worked called by vitest-pool-workers
  async unsafeAbort(reason?: string) {
    await this.ctx.storage.sync();
    await this.ctx.storage.deleteAll();

    this.ctx.abort(reason);
  }

  async storeEventMap() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const entries: Record<string, Event> = {};
      for (const [type, events] of this.eventMap.entries()) {
        for (let i = 0; i < events.length; i++) {
          entries[`${EVENT_MAP_PREFIX}\n${type}\n${i}`] = events[i];
        }
      }
      if (Object.keys(entries).length > 0) {
        await this.ctx.storage.put(entries);
      }
    });
  }

  async restoreEventMap() {
    await this.ctx.blockConcurrencyWhile(async () => {
      // FIXME(lduarte): can this OoM the DO in the production?
      const entries = await this.ctx.storage.list<Event>({
        prefix: EVENT_MAP_PREFIX,
      });
      for (const [key, value] of entries) {
        const [_, eventType, _idx] = key.split("\n");
        // NOTE(lduarte): safe to do because list returns keys in ascending order, so
        // indexes will be correctly ordered
        const eventList = this.eventMap.get(eventType) ?? [];
        eventList.push(value);
        this.eventMap.set(eventType, eventList);
      }
    });
  }

  async receiveEvent(event: {
    timestamp: Date;
    payload: unknown;
    type: string;
  }) {
    // There are four possible cases here:
    // - There is a callback waiting, send it
    // - There is no callback waiting but engine is alive, store it
    // - Engine is not awake and is in Waiting status, store it and start it up
    // - Engine is not awake and is in Paused (or another terminal) status, store it
    // - Engine is not awake and is Errored or Terminated, this should not get called
    let eventTypeQueue = this.eventMap.get(event.type) ?? [];
    eventTypeQueue.push(event as Event);

    this.eventMap.set(event.type, eventTypeQueue);
    await this.storeEventMap();

    // if the engine is running
    if (this.isRunning) {
      // Attempt to get the callback and run it
      const callbacks = this.waiters.get(event.type);
      if (callbacks) {
        const entry = callbacks[0];
        if (entry) {
          const [, resolve] = entry;
          resolve(event);
          // Remove it from the list of callbacks
          callbacks.shift();
          this.waiters.set(event.type, callbacks);

          eventTypeQueue = this.eventMap.get(event.type) ?? [];
          eventTypeQueue.shift();
          this.eventMap.set(event.type, eventTypeQueue);

          return;
        }
      }
    } else {
      const mockEvent = await this.ctx.storage.get(
        `${MODIFIER_KEYS.MOCK_EVENT}${event.type}`,
      );
      if (mockEvent) {
        return;
      }

      const metadata =
        await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);

      if (metadata === undefined) {
        throw new Error("Engine was never started");
      }

      void this.init(
        metadata.accountId,
        metadata.workflow,
        metadata.version,
        metadata.instance,
        metadata.event,
      );
    }
  }

  getInstanceModifier(): WorkflowInstanceModifier {
    return new WorkflowInstanceModifier(this, this.ctx);
  }

  async changeInstanceStatus(
    newStatus: "resume" | "pause" | "terminate" | "restart",
    from?: RestartFromStep,
  ) {
    const metadata =
      await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);

    if (metadata === undefined) {
      throw createWorkflowError(
        "Instance does not exist",
        "instance.not_found",
      );
    }

    switch (newStatus) {
      case "pause":
        await this.userTriggeredPause();
        break;
      case "resume": {
        const currentStatus = await this.getStatus();
        if (currentStatus === InstanceStatus.WaitingForPause) {
          // Engine is still running — cancel the pending pause
          this.timeoutHandler.cancelWaitingPromisesByType("pause");
          await this.setStatus(
            metadata.accountId,
            metadata.instance.id,
            InstanceStatus.Running,
          );
        } else if (currentStatus === InstanceStatus.Paused) {
          await this.attemptResume();
        }
        break;
      }
      case "terminate": {
        const currentStatus = await this.getStatus();
        if (
          [
            InstanceStatus.Terminated,
            InstanceStatus.Complete,
            InstanceStatus.Errored,
          ].includes(currentStatus)
        ) {
          throw createWorkflowError(
            "Cannot terminate instance since its on a finite state",
            "instance.cannot_terminate",
          );
        }
        await this.userTriggeredTerminate();
        break;
      }
      case "restart":
        if (from) {
          if (!resolveGroupKeysToWipe(this.ctx.storage.sql, from)) {
            throw stepNotFoundError(from.name);
          }
          await storeRestartFromStep(this.ctx.storage, from);
        }
        await this.userTriggeredRestart();
        break;
    }
  }

  async userTriggeredTerminate() {
    const metadata =
      await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);

    if (metadata === undefined) {
      throw createWorkflowError(
        "Instance does not exist",
        "instance.not_found",
      );
    }

    this.writeLog(InstanceEvent.WORKFLOW_TERMINATED, null, null, {
      trigger: {
        source: InstanceTrigger.API,
      },
    });

    await this.setStatus(
      metadata.accountId,
      metadata.instance.id,
      InstanceStatus.Terminated,
    );

    await this.abort(ABORT_REASONS.USER_TERMINATE);
  }

  async userTriggeredPause() {
    const status = await this.getStatus();

    if (
      status === InstanceStatus.Paused ||
      status === InstanceStatus.WaitingForPause
    ) {
      return;
    }

    if (
      status !== InstanceStatus.Running &&
      status !== InstanceStatus.Waiting
    ) {
      return;
    }

    const metadata =
      await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);

    if (metadata === undefined) {
      throw createWorkflowError(
        "Instance does not exist",
        "instance.not_found",
      );
    }

    await this.setStatus(
      metadata.accountId,
      metadata.instance.id,
      InstanceStatus.WaitingForPause,
    );

    void this.timeoutHandler
      .waitUntilNothingIsRunning("pause", async () => {
        await this.ctx.storage.put(PAUSE_DATETIME, new Date());
        await this.setStatus(
          metadata.accountId,
          metadata.instance.id,
          InstanceStatus.Paused,
        );
        // Signal the pause controller to interrupt any active
        // scheduler.wait (sleep/waitForEvent). The workflow will
        // throw a pause error at the next step boundary via
        // #checkForPendingPause()
        this.pauseController.abort(ABORT_REASONS.USER_PAUSE);
      })
      .catch(() => {});
  }

  async userTriggeredRestart() {
    // cleanup is done in attemptRestart() on the fresh DO instance

    await this.abort(ABORT_REASONS.USER_RESTART);
  }

  async attemptRestart() {
    const restartFromStep = await readAndClearRestartFromStep(this.ctx.storage);

    let groupKeysToWipe: Set<string> | null = null;
    if (restartFromStep) {
      groupKeysToWipe = resolveGroupKeysToWipe(
        this.ctx.storage.sql,
        restartFromStep,
      );
      if (!groupKeysToWipe) {
        throw stepNotFoundError(restartFromStep.name);
      }
    }

    await wipeRestartState(
      this.ctx.storage,
      ENGINE_STATUS_KEY,
      PAUSE_DATETIME,
      groupKeysToWipe,
    );

    const metadata =
      await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);

    if (metadata === undefined) {
      throw createWorkflowError(
        "Instance does not exist",
        "instance.not_found",
      );
    }

    const { accountId, workflow, version, instance, event } = metadata;

    if (!groupKeysToWipe) {
      this.writeLog(InstanceEvent.WORKFLOW_QUEUED, null, null, {
        params: event.payload,
        versionId: version.id,
        trigger: {
          source: InstanceTrigger.API,
        },
      });
      this.writeLog(InstanceEvent.WORKFLOW_START, null, null, {});
    }

    void this.init(accountId, workflow, version, instance, event);
  }

  async attemptResume() {
    const metadata =
      await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);

    if (metadata === undefined) {
      throw createWorkflowError(
        "Instance does not exist",
        "instance.not_found",
      );
    }

    const status =
      await this.ctx.storage.get<InstanceStatus>(ENGINE_STATUS_KEY);
    if (status !== InstanceStatus.Paused) {
      return;
    }

    // Offset priority queue timers by the pause duration so that
    // sleeps/retries resume from where they left off
    const pausedDate = await this.ctx.storage.get<Date>(PAUSE_DATETIME);
    if (pausedDate !== undefined) {
      const offset = Date.now() - new Date(pausedDate).valueOf();
      if (this.priorityQueue) {
        this.priorityQueue.offsetAll(offset);
      } else {
        const pq = new TimePriorityQueue(this.ctx, metadata);
        pq.offsetAll(offset);
      }
    }
    await this.ctx.storage.delete(PAUSE_DATETIME);

    const { accountId, workflow, version, instance, event } = metadata;

    await this.ctx.storage.put(ENGINE_STATUS_KEY, InstanceStatus.Queued);

    // Reset pause state for the new run. The DO stays alive across
    // pause/resume (no this.ctx.abort()), so we need to clear stale
    // in-memory state from the previous run to avoid duplicates.
    this.pauseController = new AbortController();
    this.waiters = new Map();
    this.eventMap = new Map();
    clearRollbackRegistry(this.rollbackRegistry);

    void this.init(accountId, workflow, version, instance, event);
  }

  async init(
    accountId: number,
    workflow: DatabaseWorkflow,
    version: DatabaseVersion,
    instance: DatabaseInstance,
    event: WorkflowEvent<unknown>,
  ) {
    if (this.priorityQueue === undefined) {
      this.priorityQueue = new TimePriorityQueue(
        this.ctx,
        // this.env,
        {
          accountId,
          workflow,
          version,
          instance,
          event,
        },
      );
    }

    if (this.isRunning) {
      return;
    }

    this.priorityQueue.popPastEntries();
    await this.priorityQueue.handleNextAlarm();

    // We are not running and are possibly starting a new lifetime
    this.accountId = accountId;
    this.instanceId = instance.id;
    this.workflowName = workflow.name;

    const status = await this.getStatus();
    if (
      [
        InstanceStatus.Errored, // TODO (WOR-85): Remove this once upgrade story is done
        InstanceStatus.Terminated,
        InstanceStatus.Complete,
        InstanceStatus.Paused,
      ].includes(status)
    ) {
      return;
    }

    // If the DO restarted (e.g. from alarm) while in WaitingForPause state,
    // transition to Paused and return early — same as production behaviour.
    if (status === InstanceStatus.WaitingForPause) {
      await this.ctx.storage.put(PAUSE_DATETIME, new Date());
      await this.setStatus(accountId, instance.id, InstanceStatus.Paused);
      return;
    }

    if ((await this.ctx.storage.get(INSTANCE_METADATA)) == undefined) {
      const instanceMetadata: InstanceMetadata = {
        accountId,
        workflow,
        version,
        instance,
        event,
      };
      await this.ctx.storage.put(INSTANCE_METADATA, instanceMetadata);

      // TODO (WOR-78): We currently don't have a queue mechanism
      this.writeLog(InstanceEvent.WORKFLOW_QUEUED, null, null, {
        params: event.payload,
        versionId: version.id,
        trigger: {
          source: InstanceTrigger.API,
        },
      });
      this.writeLog(InstanceEvent.WORKFLOW_START, null, null, {});
    }

    // restore eventMap so that waitForEvent across lifetimes works correctly
    await this.restoreEventMap();

    const stubStep = new Context(this, this.ctx);

    const workflowRunningHandler = async () => {
      await this.ctx.storage.transaction(async () => {
        // manually start the grace period
        // startGracePeriod(this, this.timeoutHandler.timeoutMs);
        await this.setStatus(accountId, instance.id, InstanceStatus.Running);
      });
    };
    this.isRunning = true;

    void workflowRunningHandler();
    try {
      const target = this.env.USER_WORKFLOW;
      const result = await target.run(
        event,
        stubStep as unknown as WorkflowStep,
      );
      this.writeLog(InstanceEvent.WORKFLOW_SUCCESS, null, null, {
        result,
      });
      // NOTE(lduarte): we want to run this in a transaction to guarentee ordering with running setstatus call
      // in case that it returns immediately
      await this.ctx.storage.transaction(async () => {
        await this.setStatus(accountId, instance.id, InstanceStatus.Complete);
      });
      // Dispose dup'd stubs; otherwise they leak across DO lifetimes.
      clearRollbackRegistry(this.rollbackRegistry);
      this.isRunning = false;
    } catch (err) {
      if (isAbortError(err)) {
        this.isRunning = false;
        return;
      }

      // Run before the terminal status so events land before WORKFLOW_FAILURE.
      try {
        await executeRollbacks(
          this,
          err instanceof Error ? err : new Error(String(err)),
        );
      } catch (rollbackErr) {
        console.error("Rollback execution failed:", rollbackErr);
      }

      let error;
      if (err instanceof Error) {
        if (
          err.name === "NonRetryableError" ||
          err.message.startsWith("NonRetryableError")
        ) {
          const fatalError = shouldPreserveNonRetryableError()
            ? new PreservedNonRetryableError(err)
            : new WorkflowFatalError(
                `The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled`,
              );

          this.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
            error: fatalError,
          });

          await this.setStatus(accountId, instance.id, InstanceStatus.Errored);
          await this.abort(ABORT_REASONS.NON_RETRYABLE_ERROR);
          this.isRunning = false;
          return;
        }
        error = {
          message: err.message,
          name: err.name,
        };
      } else {
        error = {
          name: "Error",
          message: err,
        };
      }

      this.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
        error,
      });
      // NOTE(lduarte): we want to run this in a transaction to guarentee ordering with running setstatus call
      // in case that it throws immediately
      await this.ctx.storage.transaction(async () => {
        await this.setStatus(accountId, instance.id, InstanceStatus.Errored);
      });
      this.isRunning = false;
    }

    return {
      id: instance.id,
    };
  }
}
