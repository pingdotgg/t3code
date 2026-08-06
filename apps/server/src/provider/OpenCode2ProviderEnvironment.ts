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

/**
 * Copy host auth files and seed a private DB copy that retains credentials but
 * drops host sessions. Safe to call repeatedly: existing managed DB is kept.
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
    if (!NodeFS.existsSync(source)) continue;
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
      // First managed spawn: copy host DB, then prune sessions so we keep
      // credentials without replaying host chats.
      NodeFS.copyFileSync(hostDb, managedDb);
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
    // keys / oauth tokens land without wiping managed sessions.
    const host = new NodeSqlite.DatabaseSync(hostDb, { readOnly: true });
    const managed = new NodeSqlite.DatabaseSync(managedDb);
    try {
      const rows = host.prepare("SELECT * FROM credential").all() as Array<Record<string, unknown>>;
      if (rows.length === 0) return;
      managed.exec("DELETE FROM credential");
      const columns = Object.keys(rows[0] ?? {});
      if (columns.length === 0) return;
      const placeholders = columns.map(() => "?").join(", ");
      const insert = managed.prepare(
        `INSERT INTO credential (${columns.join(", ")}) VALUES (${placeholders})`,
      );
      for (const row of rows) {
        insert.run(...columns.map((column) => row[column]));
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
