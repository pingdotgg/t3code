import type {
  AuditLogEventTypeInfoResultItem,
  AuditLogResponse,
  AuditLogsResponseEdgesItemNode,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import { resolveWorkspaceId } from "./Environment.ts";

/**
 * Project identity for {@link listAuditLogs}. Accepts a `Railway.Project`
 * or a `{ projectId }` stub.
 */
export type AuditLogProject = {
  readonly projectId: string;
};

/**
 * Environment identity for {@link listAuditLogs}. Accepts a
 * `Railway.Project` (primary environment), a `Railway.Environment`, or
 * `{ environmentId }`.
 */
export type AuditLogEnvironment = {
  readonly environmentId: string;
};

export interface ListAuditLogsOptions {
  /**
   * Restrict to a project. Accepts a `Railway.Project` or `{ projectId }`.
   */
  project?: AuditLogProject | string;
  /**
   * Restrict to an environment. Accepts a `Railway.Project`, a
   * `Railway.Environment`, or `{ environmentId }`.
   */
  environment?: AuditLogEnvironment | string;
  /**
   * Event type names from {@link listAuditLogEventTypes}.
   */
  eventTypes?: readonly string[];
  /**
   * Inclusive start (RFC3339).
   */
  startDate?: string;
  /**
   * Inclusive end (RFC3339).
   */
  endDate?: string;
  /**
   * Workspace id. Defaults to the current token workspace.
   */
  workspaceId?: string;
  /**
   * Page size. Defaults to 50. This helper fetches one page — it does
   * not walk the whole workspace history.
   * @default 50
   */
  first?: number;
  /**
   * Sort by `createdAt`. Railway default is `desc`.
   */
  sort?: "asc" | "desc";
}

/**
 * One workspace audit-log row from `auditLogs` / `auditLog`.
 */
export interface AuditLogEntry {
  /** Audit log id. */
  readonly id: string;
  /** Event type name (see {@link listAuditLogEventTypes}). */
  readonly eventType: string;
  /** RFC3339 creation timestamp. */
  readonly createdAt: string;
  /** Workspace the event was recorded in. */
  readonly workspaceId: string | undefined;
  /** Project the event targeted, when Railway attached one. */
  readonly projectId: string | undefined;
  /** Environment the event targeted, when Railway attached one. */
  readonly environmentId: string | undefined;
  /** Event payload. Shape depends on `eventType`. */
  readonly payload: unknown;
  /** Extra context Railway attached to the event. */
  readonly context: unknown;
}

export type AuditLogEventType = AuditLogEventTypeInfoResultItem;

type AuditLogRow = AuditLogResponse | AuditLogsResponseEdgesItemNode;

const toEntry = (row: AuditLogRow): AuditLogEntry => ({
  id: row.id,
  eventType: row.eventType,
  createdAt: row.createdAt,
  workspaceId: row.workspaceId ?? undefined,
  projectId: row.projectId ?? undefined,
  environmentId: row.environmentId ?? undefined,
  payload: row.payload ?? undefined,
  context: row.context ?? undefined,
});

const projectIdOf = (
  value: AuditLogProject | string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return value.projectId;
};

const environmentIdOf = (
  value: AuditLogEnvironment | string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return value.environmentId;
};

const workspaceOf = (workspaceId: string | undefined) =>
  workspaceId !== undefined
    ? Effect.succeed(workspaceId)
    : resolveWorkspaceId();

/**
 * List workspace audit logs. Query-only — Railway has no audit-log
 * create/update/delete, so this is a catalog helper, not a resource.
 *
 * Defaults to the current token workspace. Pass `project` /
 * `environment` to filter. The result may be empty.
 *
 * @see https://docs.railway.com/reference/audit-logs
 *
 * ### List logs
 * **Example:** Workspace logs
 * ```typescript
 * const logs = yield* Railway.listAuditLogs();
 * ```
 *
 * **Example:** Filter by project
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const logs = yield* Railway.listAuditLogs({
 *   project: site,
 *   environment: site,
 * });
 * ```
 *
 * ### Get by id
 * **Example:** One row
 * ```typescript
 * const log = yield* Railway.getAuditLog({ id: logs[0].id });
 * ```
 *
 * ### Event types
 * **Example:** Catalog
 * ```typescript
 * const types = yield* Railway.listAuditLogEventTypes();
 * ```
 *
 * @resource
 */
export const AuditLog = Effect.fn(function* (options?: ListAuditLogsOptions) {
  const workspaceId = yield* workspaceOf(options?.workspaceId);
  const projectId = projectIdOf(options?.project);
  const environmentId = environmentIdOf(options?.environment);
  const first = options?.first ?? 50;
  const filter =
    projectId !== undefined ||
    environmentId !== undefined ||
    options?.eventTypes !== undefined ||
    options?.startDate !== undefined ||
    options?.endDate !== undefined
      ? {
          ...(projectId !== undefined ? { projectId } : {}),
          ...(environmentId !== undefined ? { environmentId } : {}),
          ...(options?.eventTypes !== undefined
            ? { eventTypes: [...options.eventTypes] }
            : {}),
          ...(options?.startDate !== undefined
            ? { startDate: options.startDate }
            : {}),
          ...(options?.endDate !== undefined
            ? { endDate: options.endDate }
            : {}),
        }
      : undefined;

  const page = yield* railway
    .auditLogs({
      workspaceId,
      first,
      ...(options?.sort !== undefined ? { sort: options.sort } : {}),
      ...(filter !== undefined ? { filter } : {}),
    })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({
          edges: [] as { node: AuditLogsResponseEdgesItemNode }[],
        }),
      ),
    );

  return (page.edges ?? []).map((edge) => toEntry(edge.node));
});

/** Alias of {@link AuditLog}. */
export const listAuditLogs = AuditLog;

/**
 * Fetch one audit log by id. Workspace defaults to the current token
 * workspace.
 *
 * @example Get by id
 * ```typescript
 * const log = yield* Railway.getAuditLog({ id: logs[0].id });
 * ```
 */
export const getAuditLog = Effect.fn(function* (options: {
  id: string;
  workspaceId?: string;
}) {
  const workspaceId = yield* workspaceOf(options.workspaceId);
  const row = yield* railway.auditLog({
    id: options.id,
    workspaceId,
  });
  return toEntry(row);
});

/**
 * Event types Railway can record, with descriptions.
 *
 * @example Event type catalog
 * ```typescript
 * const types = yield* Railway.listAuditLogEventTypes();
 * ```
 */
export const listAuditLogEventTypes = Effect.fn(function* () {
  const types = yield* railway.auditLogEventTypeInfo({});
  return types ?? [];
});
