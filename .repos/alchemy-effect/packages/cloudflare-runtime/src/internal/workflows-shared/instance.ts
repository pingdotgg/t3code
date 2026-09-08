// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { ResolvedStepConfig } from "./context.ts";
import type {
  DatabaseInstance,
  DatabaseVersion,
  DatabaseWorkflow,
} from "./engine.ts";
import type { WorkflowEvent } from "cloudflare:workers";

export type Instance = {
  id: string;
  created_on: string;
  modified_on: string;
  workflow_id: string;
  version_id: string;
  status: InstanceStatus;
  started_on: string | null;
  ended_on: string | null;
};

export const INSTANCE_METADATA = `INSTANCE_METADATA`;

export type InstanceMetadata = {
  accountId: number;
  workflow: DatabaseWorkflow;
  version: DatabaseVersion;
  instance: DatabaseInstance;
  event: WorkflowEvent<unknown>;
};

export enum InstanceStatus {
  Queued = 0, // Queued and waiting to start
  Running = 1,
  Paused = 2, // TODO (WOR-73): Implement pause
  Errored = 3, // Stopped due to a user or system Error
  Terminated = 4, // Stopped explicitly by user
  Complete = 5, // Successful completion
  WaitingForPause = 6,
  Waiting = 7,
}

export function instanceStatusName(status: InstanceStatus) {
  switch (status) {
    case InstanceStatus.Queued:
      return "queued";
    case InstanceStatus.Running:
      return "running";
    case InstanceStatus.Paused:
      return "paused";
    case InstanceStatus.Errored:
      return "errored";
    case InstanceStatus.Terminated:
      return "terminated";
    case InstanceStatus.Complete:
      return "complete";
    case InstanceStatus.WaitingForPause:
      return "waitingForPause";
    case InstanceStatus.Waiting:
      return "waiting";
    default:
      return "unknown";
  }
}

export const instanceStatusNames = [
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waitingForPause",
  "waiting",
  "unknown",
] as const;

export function toInstanceStatus(status: string): InstanceStatus {
  switch (status) {
    case "queued":
      return InstanceStatus.Queued;
    case "running":
      return InstanceStatus.Running;
    case "paused":
      return InstanceStatus.Paused;
    case "errored":
      return InstanceStatus.Errored;
    case "terminated":
      return InstanceStatus.Terminated;
    case "complete":
      return InstanceStatus.Complete;
    case "waitingForPause":
      return InstanceStatus.WaitingForPause;
    case "waiting":
      return InstanceStatus.Waiting;
    case "unknown":
      throw new Error("unknown cannot be parsed into a InstanceStatus");
    default:
      throw new Error(
        `${status} was not handled because it's not a valid InstanceStatus`,
      );
  }
}

export const enum InstanceEvent {
  WORKFLOW_QUEUED = 0,
  WORKFLOW_START = 1,
  WORKFLOW_SUCCESS = 2,
  WORKFLOW_FAILURE = 3,
  WORKFLOW_TERMINATED = 4,

  STEP_START = 5,
  STEP_SUCCESS = 6,
  STEP_FAILURE = 7,

  SLEEP_START = 8,
  SLEEP_COMPLETE = 9,

  ATTEMPT_START = 10,
  ATTEMPT_SUCCESS = 11,
  ATTEMPT_FAILURE = 12,

  // It's here just to make it sequential and to not have gaps in the event types.
  __INTERNAL_PROD = 13,

  WAIT_START = 14,
  WAIT_COMPLETE = 15,
  WAIT_TIMED_OUT = 16,

  ROLLBACK_START = 17,
  ROLLBACK_STEP_START = 18,
  ROLLBACK_ATTEMPT_START = 19,
  ROLLBACK_ATTEMPT_SUCCESS = 20,
  ROLLBACK_ATTEMPT_FAILURE = 21,
  ROLLBACK_STEP_SUCCESS = 22,
  ROLLBACK_STEP_FAILURE = 23,
  ROLLBACK_COMPLETE = 24,
  ROLLBACK_FAILED = 25,
}

export const enum InstanceTrigger {
  API = 0,
  BINDING = 1,
  EVENT = 2,
  CRON = 3,
}

export function instanceTriggerName(trigger: InstanceTrigger) {
  switch (trigger) {
    case InstanceTrigger.API:
      return "api";
    case InstanceTrigger.BINDING:
      return "binding";
    case InstanceTrigger.EVENT:
      return "event";
    case InstanceTrigger.CRON:
      return "cron";
    default:
      return "unknown";
  }
}

export type RawInstanceLog = {
  id: number;
  timestamp: string;
  event: InstanceEvent;
  groupKey: string | null;
  target: string | null;
  metadata: string;
};

export type InstanceAttempt = {
  start: string;
  end: string | null;
  success: boolean | null;
  error: { name: string; message: string } | null;
};

export type InstanceStepLog = {
  name: string;
  start: string;
  end: string | null;
  attempts: Array<InstanceAttempt>;
  config: ResolvedStepConfig;
  output: unknown;
  success: boolean | null;
  type: "step";
};

export type InstanceSleepLog = {
  name: string;
  start: string;
  end: string;
  finished: boolean;
  type: "sleep";
};

export type InstanceTerminateLog = {
  type: "termination";
  trigger: {
    source: string;
  };
};

export type InstanceLogsResponse = {
  params: Record<string, unknown>;
  trigger: {
    source: ReturnType<typeof instanceTriggerName>;
  };
  versionId: string;
  queued: string;
  start: string | null;
  end: string | null;
  steps: Array<InstanceStepLog | InstanceSleepLog | InstanceTerminateLog>;
  success: boolean | null;
  error: { name: string; message: string } | null;
  output: Rpc.Serializable<unknown>;
};

export type WakerPriorityEntry = {
  hash: string;
  type: WakerPriorityType;
  targetTimestamp: number;
};

export type WakerPriorityType = "sleep" | "retry" | "timeout";
