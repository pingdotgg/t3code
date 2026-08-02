import * as NodeSqlite from "node:sqlite";

import packageJson from "../../package.json" with { type: "json" };
import { migrationManifest } from "../persistence/Migrations.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

const localUpdateReason = (version: string) =>
  `This version includes a database update and cannot be installed remotely. Run \`npx t3@${version} service update\` on the server machine.`;

const isMigrationRow = (
  value: unknown,
): value is { readonly migration_id: number; readonly name: string } =>
  typeof value === "object" &&
  value !== null &&
  "migration_id" in value &&
  typeof value.migration_id === "number" &&
  "name" in value &&
  typeof value.name === "string";

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason:
        "This release requires a newer T3 Code service launcher. Update it on the server machine.",
    };
  }

  try {
    const database = new NodeSqlite.DatabaseSync(input.databasePath, { readOnly: true });
    try {
      const rows: ReadonlyArray<unknown> = database
        .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
        .all();
      const exact =
        rows.length === migrationManifest.length &&
        rows.every((row, index) => {
          const expected = migrationManifest[index];
          return (
            isMigrationRow(row) && row.migration_id === expected?.[0] && row.name === expected?.[1]
          );
        });
      if (!exact) return { status: "blocked", version, reason: localUpdateReason(version) };
    } finally {
      database.close();
    }
  } catch {
    return { status: "blocked", version, reason: localUpdateReason(version) };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
