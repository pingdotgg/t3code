import * as Redacted from "effect/Redacted";
import type { DatabaseStatus } from "../Types.ts";

/**
 * Structural shapes for cloud values that reach shared helpers from more than
 * one source.
 *
 * `Types.ts` narrows discriminants to literals (`type: "database"`) and types
 * secrets as plain strings, while the generated distilled schemas type those
 * fields as `string` and `string | Redacted.Redacted<string>`. Helpers used by
 * both migrated and unmigrated resource files therefore accept the minimum
 * each one actually reads, which both sides satisfy.
 */

export interface ObservedEndpoint {
  readonly host?: string;
  readonly connectionString?: string | Redacted.Redacted<string> | undefined;
}

export interface ObservedConnection {
  readonly endpoints?: {
    readonly direct?: ObservedEndpoint | undefined;
    readonly pooled?: ObservedEndpoint | undefined;
    readonly accelerate?: ObservedEndpoint | undefined;
  };
}

export interface ObservedDatabase {
  readonly id: string;
  readonly name: string;
  readonly status: DatabaseStatus;
  readonly defaultConnectionId: string | null;
  readonly connections: ReadonlyArray<
    ObservedConnection & { readonly id: string }
  >;
  readonly region?: { readonly id: string; readonly name: string } | null;
}

export interface ObservedConnectionRecord extends ObservedConnection {
  readonly id: string;
  readonly name: string;
  readonly kind: "postgres" | "accelerate";
  readonly createdAt: string;
  readonly database: { readonly id: string };
}

export interface ObservedSourceRepository {
  readonly id: string;
  readonly projectId: string;
  readonly repoId: number;
  readonly provider: "github";
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly status: "active" | "archived";
  readonly installationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ObservedEnvironmentVariable {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string | null;
  readonly class: "production" | "preview";
  readonly key: string;
  readonly valueKid: string;
  readonly isManagedBySystem: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ObservedBucketKey {
  readonly id: string;
  readonly name: string;
}

export interface ObservedBucket {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly project: { readonly id: string };
}

export interface ObservedApp {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly region: { readonly id: string };
  readonly branchId: string | null;
  readonly latestDeploymentId: string | null;
  readonly appEndpointDomain: string;
  readonly createdAt: string;
}

export interface ObservedDeployment {
  readonly id: string;
  readonly foundryVersionId: string;
  readonly status: string;
  readonly previewDomain: string | null;
  readonly createdAt?: string;
}

export interface ObservedBranch {
  readonly id: string;
  readonly gitName: string;
  readonly isDefault: boolean;
  readonly role: "production" | "preview";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly project: { readonly id: string };
}

/**
 * The Management API types a database's `source` discriminant as a plain
 * string. {@link narrowDatabaseSource} turns an observed value back into the
 * discriminated union the diffing logic needs, by checking the fields rather
 * than asserting them.
 */
export interface ObservedSource {
  readonly type: string;
  readonly databaseId?: string;
  readonly backupId?: string;
}

export interface ObservedProjectDatabase extends ObservedDatabase {
  readonly isDefault: boolean;
  readonly branchId: string | null;
  readonly createdAt: string;
  readonly source: ObservedSource | null;
  readonly project: { readonly id: string };
}

export interface ObservedProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly defaultRegion: string | null;
  readonly workspace: { readonly id: string };
}

/** Read a required possibly-redacted secret as a plain string. */
export const requiredSecretValue = (
  value: string | Redacted.Redacted<string>,
): string => (typeof value === "string" ? value : Redacted.value(value));

/** Read a possibly-redacted secret as a plain string. */
export const secretValue = (
  value: string | Redacted.Redacted<string> | undefined | null,
): string | undefined =>
  value === undefined || value === null
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

/**
 * Recover the discriminated source union from an observed database's
 * string-typed `source`. A missing source reads as `empty`, matching how the
 * diffing logic already treats it. An unrecognized shape reads as `unknown`,
 * which deliberately matches no desired source, so the immutable-source
 * refusals fire instead of silently accepting it.
 */
export const narrowDatabaseSource = (
  source: ObservedSource | undefined | null,
):
  | { readonly type: "empty" }
  | { readonly type: "unknown" }
  | { readonly type: "database"; readonly databaseId: string }
  | {
      readonly type: "backup";
      readonly databaseId: string;
      readonly backupId: string;
    } => {
  if (source == null) return { type: "empty" };
  if (source.type === "empty") return { type: "empty" };
  if (source.type === "database" && source.databaseId !== undefined) {
    return { type: "database", databaseId: source.databaseId };
  }
  if (
    source.type === "backup" &&
    source.databaseId !== undefined &&
    source.backupId !== undefined
  ) {
    return {
      type: "backup",
      databaseId: source.databaseId,
      backupId: source.backupId,
    };
  }
  return { type: "unknown" };
};
