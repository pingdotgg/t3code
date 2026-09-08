import type { RegionsResultItem } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { resolveWorkspace } from "./Environment.ts";

export type CatalogKind = "region" | "workspace";

export class CatalogNotFound extends Data.TaggedError(
  "Railway.CatalogNotFound",
)<{
  kind: CatalogKind;
  ref: string;
}> {}

const notFound = (kind: CatalogKind, ref: string) =>
  new CatalogNotFound({ kind, ref });

/**
 * Current token workspace (`me.workspace ?? me.workspaces[0]`).
 * Feeds `projectCreate({ input: { workspaceId } })`. Not a resource.
 */
export const currentWorkspace = resolveWorkspace;

/**
 * List Railway regions via `regions`. Pass `projectId` to scope the
 * catalog to a project; omit it for the workspace default set.
 */
export const listRegions = Effect.fn(function* (projectId?: string) {
  const regions = yield* railway.regions(
    projectId === undefined ? {} : { projectId },
  );
  return regions ?? [];
});

/**
 * Resolve a Railway region by code (`us-west2`, `us-east4`, …), display
 * name, or id.
 */
export const findRegion = (ref: string) =>
  Effect.gen(function* () {
    const regions = yield* listRegions();
    const found = regions.find(
      (item) => item.region === ref || item.name === ref || item.id === ref,
    );
    if (found === undefined) {
      return yield* notFound("region", ref);
    }
    return found;
  });

export type RailwayRegion = RegionsResultItem;

/**
 * Workspace audit logs. Query-only — Railway has no audit-log
 * create/update/delete, so this is not a resource.
 */
export {
  AuditLog,
  getAuditLog,
  listAuditLogEventTypes,
  listAuditLogs,
  type AuditLogEntry,
  type AuditLogEnvironment,
  type AuditLogEventType,
  type AuditLogProject,
  type ListAuditLogsOptions,
} from "./AuditLog.ts";
