// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  applyOpenCode2ProviderEnvironment,
  OPENCODE2_BACKGROUND_SUBAGENTS_ENV,
  openCode2ManagedStateRoot,
  seedOpenCode2ManagedDataHome,
} from "./OpenCode2ProviderEnvironment.ts";

describe("applyOpenCode2ProviderEnvironment", () => {
  it("explicitly enables background subagents for a managed server", () => {
    const env = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      {
        OPENCODE_EXPERIMENTAL: "false",
        TMPDIR: "/tmp/t3-opencode2-env-test",
        [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "false",
      },
    );
    expect(env).toMatchObject({
      OPENCODE_EXPERIMENTAL: "false",
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "true",
    });
    const root = openCode2ManagedStateRoot({ TMPDIR: "/tmp/t3-opencode2-env-test" });
    expect(env.XDG_STATE_HOME).toBe(NodePath.join(root, "state"));
    expect(env.XDG_DATA_HOME).toBe(NodePath.join(root, "data"));
    // Host config is preserved so user provider definitions still apply.
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it("explicitly disables background subagents even under the umbrella experiment", () => {
    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: false, serverUrl: "" },
        { OPENCODE_EXPERIMENTAL: "true", TMPDIR: "/tmp/t3-opencode2-env-test-2" },
      ),
    ).toMatchObject({
      OPENCODE_EXPERIMENTAL: "true",
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "false",
    });
  });

  it("does not claim control over an external server environment", () => {
    const environment = { [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "external" };

    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: true, serverUrl: " http://127.0.0.1:4096 " },
        environment,
      ),
    ).toBe(environment);
  });
});

function writeHostOpenCodeDb(
  hostOpenCode: string,
  options: {
    readonly credentials?: ReadonlyArray<{
      readonly id: string;
      readonly integration_id: string;
      readonly label: string;
      readonly value: string;
    }>;
    readonly withSession?: boolean;
  } = {},
): void {
  const hostDb = NodePath.join(hostOpenCode, "opencode.db");
  const hostSql = new NodeSqlite.DatabaseSync(hostDb);
  hostSql.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      active INTEGER
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT
    );
  `);
  for (const credential of options.credentials ?? []) {
    hostSql
      .prepare(
        `INSERT INTO credential (id, integration_id, label, value, active)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(credential.id, credential.integration_id, credential.label, credential.value);
  }
  if (options.withSession !== false) {
    hostSql.exec(`INSERT INTO session (id, title) VALUES ('ses_host', 'Host chat')`);
  }
  hostSql.close();
}

describe("seedOpenCode2ManagedDataHome", () => {
  it("copies auth files and credentials from the host DB without sessions", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(hostOpenCode, "auth.json"), '{"opencode":{"type":"api"}}\n');
    writeHostOpenCodeDb(hostOpenCode, {
      credentials: [
        {
          id: "cred_1",
          integration_id: "opencode",
          label: "default",
          value: '{"type":"key","key":"sk-test"}',
        },
      ],
    });

    seedOpenCode2ManagedDataHome(managed, host);

    expect(NodeFS.readFileSync(NodePath.join(managed, "opencode", "auth.json"), "utf8")).toContain(
      "opencode",
    );
    const managedDb = new NodeSqlite.DatabaseSync(
      NodePath.join(managed, "opencode", "opencode.db"),
    );
    try {
      const credentials = managedDb
        .prepare("SELECT id, integration_id FROM credential")
        .all() as Array<{
        id: string;
        integration_id: string;
      }>;
      expect(credentials).toEqual([{ id: "cred_1", integration_id: "opencode" }]);
      const sessions = managedDb.prepare("SELECT COUNT(*) AS n FROM session").get() as {
        n: number;
      };
      expect(sessions.n).toBe(0);
    } finally {
      managedDb.close();
    }
  });

  it("refreshes credentials transactionally and revokes host logouts", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-refresh-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(hostOpenCode, "auth.json"), '{"opencode":{"type":"api"}}\n');
    writeHostOpenCodeDb(hostOpenCode, {
      credentials: [
        {
          id: "cred_1",
          integration_id: "opencode",
          label: "default",
          value: '{"type":"key","key":"sk-old"}',
        },
      ],
    });

    seedOpenCode2ManagedDataHome(managed, host);

    // Host rotates the key and keeps auth.
    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "opencode.db"));
    for (const suffix of ["-wal", "-shm"] as const) {
      const companion = NodePath.join(hostOpenCode, `opencode.db${suffix}`);
      try {
        NodeFS.unlinkSync(companion);
      } catch {
        // Companion files may be absent after close.
      }
    }
    writeHostOpenCodeDb(hostOpenCode, {
      credentials: [
        {
          id: "cred_2",
          integration_id: "opencode",
          label: "default",
          value: '{"type":"key","key":"sk-new"}',
        },
      ],
      withSession: false,
    });
    seedOpenCode2ManagedDataHome(managed, host);

    const managedDbPath = NodePath.join(managed, "opencode", "opencode.db");
    {
      const managedDb = new NodeSqlite.DatabaseSync(managedDbPath);
      try {
        const credentials = managedDb
          .prepare("SELECT id FROM credential ORDER BY id")
          .all() as Array<{
          id: string;
        }>;
        expect(credentials).toEqual([{ id: "cred_2" }]);
      } finally {
        managedDb.close();
      }
    }

    // Host logout: auth file gone and credential table empty.
    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "auth.json"));
    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "opencode.db"));
    for (const suffix of ["-wal", "-shm"] as const) {
      const companion = NodePath.join(hostOpenCode, `opencode.db${suffix}`);
      try {
        NodeFS.unlinkSync(companion);
      } catch {
        // Optional.
      }
    }
    writeHostOpenCodeDb(hostOpenCode, { credentials: [], withSession: false });
    seedOpenCode2ManagedDataHome(managed, host);

    expect(NodeFS.existsSync(NodePath.join(managed, "opencode", "auth.json"))).toBe(false);
    const managedDb = new NodeSqlite.DatabaseSync(managedDbPath);
    try {
      const credentials = managedDb.prepare("SELECT COUNT(*) AS n FROM credential").get() as {
        n: number;
      };
      expect(credentials.n).toBe(0);
    } finally {
      managedDb.close();
    }
  });

  it("keeps the prior credential set when a refresh insert fails", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-tx-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    writeHostOpenCodeDb(hostOpenCode, {
      credentials: [
        {
          id: "cred_1",
          integration_id: "opencode",
          label: "default",
          value: '{"type":"key","key":"sk-keep"}',
        },
      ],
    });
    seedOpenCode2ManagedDataHome(managed, host);

    // Host adds a column the managed schema lacks so INSERT fails mid-refresh.
    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "opencode.db"));
    for (const suffix of ["-wal", "-shm"] as const) {
      try {
        NodeFS.unlinkSync(NodePath.join(hostOpenCode, `opencode.db${suffix}`));
      } catch {
        // Optional.
      }
    }
    const hostDb = NodePath.join(hostOpenCode, "opencode.db");
    const hostSql = new NodeSqlite.DatabaseSync(hostDb);
    hostSql.exec(`
      CREATE TABLE credential (
        id TEXT PRIMARY KEY,
        integration_id TEXT,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        active INTEGER,
        new_host_only TEXT
      );
      INSERT INTO credential (id, integration_id, label, value, active, new_host_only)
        VALUES ('cred_bad', 'opencode', 'default', '{"type":"key","key":"sk-bad"}', 1, 'x');
    `);
    hostSql.close();

    seedOpenCode2ManagedDataHome(managed, host);

    const managedDb = new NodeSqlite.DatabaseSync(
      NodePath.join(managed, "opencode", "opencode.db"),
    );
    try {
      const credentials = managedDb.prepare("SELECT id FROM credential").all() as Array<{
        id: string;
      }>;
      expect(credentials).toEqual([{ id: "cred_1" }]);
    } finally {
      managedDb.close();
    }
  });
});
