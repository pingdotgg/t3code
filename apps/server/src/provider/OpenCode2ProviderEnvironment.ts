// @effect-diagnostics nodeBuiltinImport:off
import type { OpenCode2Settings } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const OPENCODE2_BACKGROUND_SUBAGENTS_ENV = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS";

const OPENCODE2_AUTH_FILES = ["account.json", "auth-v2.json", "auth.json"] as const;

/**
 * Session/runtime tables pruned from a seeded host DB so we keep credentials
 * without reusing host chat sessions in the managed instance.
 */
const OPENCODE2_SESSION_TABLES = [
  "event",
  "event_sequence",
  "instruction_blob",
  "instruction_entry",
  "instruction_state",
  "message",
  "part",
  "permission",
  "session",
  "session_message",
  "session_pending",
  "session_share",
  "session_v2",
  "todo",
] as const;

/**
 * Self-spawned 2.x servers get an isolated data/state tree so they do not share
 * a live `opencode.db` with a desktop `opencode2 serve --service`. Host auth is
 * bridged in: next-line stores provider credentials in the sqlite `credential`
 * table (not only auth.json), and without that seed only free models appear.
 */
export function openCode2ManagedStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(environment.TMPDIR?.trim() || NodeOS.tmpdir(), "t3-opencode2-state");
}

export function openCode2HostDataHome(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.XDG_DATA_HOME?.trim() ||
    NodePath.join(environment.HOME?.trim() || NodeOS.homedir(), ".local", "share")
  );
}

function sqlQuoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Copy host auth files and seed a private DB copy that retains credentials but
 * drops host sessions. Safe to call repeatedly: existing managed DB is kept.
 * Auth files and credential rows that disappear on the host are removed from
 * the managed tree so logout revokes authority for the isolated instance too.
 *
 * @internal exported for tests
 */
export function seedOpenCode2ManagedDataHome(
  managedDataHome: string,
  hostDataHome: string = openCode2HostDataHome(),
): void {
  const hostOpenCode = NodePath.join(hostDataHome, "opencode");
  const managedOpenCode = NodePath.join(managedDataHome, "opencode");
  NodeFS.mkdirSync(managedOpenCode, { recursive: true });

  for (const name of OPENCODE2_AUTH_FILES) {
    const source = NodePath.join(hostOpenCode, name);
    const target = NodePath.join(managedOpenCode, name);
    if (!NodeFS.existsSync(source)) {
      try {
        if (NodeFS.existsSync(target)) NodeFS.unlinkSync(target);
      } catch {
        // Best-effort revoke: a locked managed auth file should not block spawn.
      }
      continue;
    }
    try {
      NodeFS.copyFileSync(source, target);
    } catch {
      // Best-effort: a locked or unreadable host auth file should not block spawn.
    }
  }

  const hostDb = NodePath.join(hostOpenCode, "opencode.db");
  const managedDb = NodePath.join(managedOpenCode, "opencode.db");
  if (!NodeFS.existsSync(hostDb)) return;

  try {
    if (!NodeFS.existsSync(managedDb)) {
      // First managed spawn: take a transactionally consistent host snapshot
      // (VACUUM INTO, not a live main-db file copy without WAL companions),
      // then prune sessions so we keep credentials without replaying host chats.
      const hostSnapshot = new NodeSqlite.DatabaseSync(hostDb, { readOnly: true });
      try {
        hostSnapshot.exec(`VACUUM INTO ${sqlQuoteLiteral(managedDb)}`);
      } finally {
        hostSnapshot.close();
      }
      const db = new NodeSqlite.DatabaseSync(managedDb);
      try {
        for (const table of OPENCODE2_SESSION_TABLES) {
          try {
            db.exec(`DELETE FROM ${table}`);
          } catch {
            // Table may not exist on older schemas.
          }
        }
        try {
          db.exec("VACUUM");
        } catch {
          // Optional.
        }
      } finally {
        db.close();
      }
      return;
    }

    // Subsequent spawns: refresh credential rows from the host DB so new API
    // keys / oauth tokens land without wiping managed sessions. Empty host
    // rows clear managed credentials so host logout revokes them.
    const host = new NodeSqlite.DatabaseSync(hostDb, { readOnly: true });
    const managed = new NodeSqlite.DatabaseSync(managedDb);
    try {
      const rows = host.prepare("SELECT * FROM credential").all() as Array<
        Record<string, NodeSqlite.SQLInputValue>
      >;
      const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      managed.exec("BEGIN IMMEDIATE");
      try {
        managed.exec("DELETE FROM credential");
        if (rows.length > 0 && columns.length > 0) {
          const placeholders = columns.map(() => "?").join(", ");
          const insert = managed.prepare(
            `INSERT INTO credential (${columns.join(", ")}) VALUES (${placeholders})`,
          );
          for (const row of rows) {
            insert.run(...columns.map((column) => row[column] ?? null));
          }
        }
        managed.exec("COMMIT");
      } catch (error) {
        try {
          managed.exec("ROLLBACK");
        } catch {
          // Connection may already be aborted.
        }
        throw error;
      }
    } finally {
      host.close();
      managed.close();
    }
  } catch {
    // If seed fails, leave auth.json bridge only; free models still work.
    if (!NodeFS.existsSync(managedDb)) return;
  }
}

export function applyOpenCode2ProviderEnvironment(
  settings: Pick<OpenCode2Settings, "backgroundSubagents" | "serverUrl">,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (settings.serverUrl.trim().length > 0) {
    return environment;
  }

  const hostDataHome = openCode2HostDataHome(environment);
  const stateRoot = openCode2ManagedStateRoot(environment);
  const xdgStateHome = NodePath.join(stateRoot, "state");
  const xdgDataHome = NodePath.join(stateRoot, "data");
  for (const dir of [xdgStateHome, xdgDataHome]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  seedOpenCode2ManagedDataHome(xdgDataHome, hostDataHome);

  // Keep the host XDG_CONFIG_HOME so user provider config (e.g. llama.cpp)
  // still applies. Isolate only state (server password) and data (db/auth).
  return {
    ...environment,
    [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: settings.backgroundSubagents ? "true" : "false",
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
  };
}
