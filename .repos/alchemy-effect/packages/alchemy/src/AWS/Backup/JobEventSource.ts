import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Backup delivers to EventBridge when a backup,
 * restore, or copy job — or a recovery point / vault — changes state. Job
 * events carry the job id and `state`; recovery-point events carry the
 * recovery point ARN and `status`. Fields not shared by every event kind are
 * optional (the schema grows over time).
 */
export interface BackupEventDetail {
  /** Backup-job events: the backup job id. */
  backupJobId?: string;
  /** Restore-job events: the restore job id. */
  restoreJobId?: string;
  /** Copy-job events: the copy job id. */
  copyJobId?: string;
  /** Job events: the new job state, e.g. `COMPLETED`, `FAILED`, `ABORTED`. */
  state?: string;
  /** Recovery-point events: the new status, e.g. `COMPLETED`, `EXPIRED`. */
  status?: string;
  /** Recovery-point events: the recovery point ARN. */
  recoveryPointArn?: string;
  /** Vault / recovery-point events: the backup vault name. */
  backupVaultName?: string;
  /** Vault events: the backup vault ARN. */
  backupVaultArn?: string;
  /** The ARN of the resource being backed up / restored. */
  resourceArn?: string;
  /** The type of the resource, e.g. `DynamoDB`, `EBS`. */
  resourceType?: string;
  /** The IAM role AWS Backup assumed for the job. */
  iamRoleArn?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Backup EventBridge event delivered to the handler. */
export type BackupEvent = EventRecord<BackupEventDetail>;

/** Which AWS Backup state-change events to subscribe to. */
export type BackupEventKind =
  | "backup-job"
  | "restore-job"
  | "copy-job"
  | "recovery-point"
  | "backup-vault"
  | "backup-plan";

const DETAIL_TYPES: Record<BackupEventKind, string> = {
  "backup-job": "Backup Job State Change",
  "restore-job": "Restore Job State Change",
  "copy-job": "Copy Job State Change",
  "recovery-point": "Recovery Point State Change",
  "backup-vault": "Backup Vault State Change",
  "backup-plan": "Backup Plan State Change",
};

export interface BackupEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "BackupEvents"
   */
  id?: string;
  /**
   * Which state-change events to subscribe to.
   * @default all kinds
   */
  kinds?: readonly BackupEventKind[];
}

/**
 * Event source connecting AWS Backup state changes to the hosting compute.
 * AWS Backup publishes every backup / restore / copy job, recovery point,
 * vault, and plan state change to the account's default EventBridge bus
 * (source `aws.backup`); this subscribes the host Function to those events
 * so it can alert on failed jobs or chain post-backup automation.
 *
 * AWS Backup publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Backup Events
 * @example Alert On Failed Backup Jobs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Backup.consumeBackupEvents(
 *       { kinds: ["backup-job"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.state === "FAILED"
 *             ? Effect.log(`backup job ${event.detail.backupJobId} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeBackupEvents = <StreamReq = never, Req = never>(
  props: BackupEventSourceProps,
  process: (
    events: Stream.Stream<BackupEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "BackupEvents",
    {
      source: ["aws.backup"],
      "detail-type": (
        props.kinds ?? (Object.keys(DETAIL_TYPES) as BackupEventKind[])
      ).map((kind) => DETAIL_TYPES[kind]),
    },
    { description: props.description, state: props.state },
    process,
  );
