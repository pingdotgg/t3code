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

describe("seedOpenCode2ManagedDataHome", () => {
  it("copies auth files and credentials from the host DB without sessions", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(hostOpenCode, "auth.json"), '{"opencode":{"type":"api"}}\n');

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
      INSERT INTO credential (id, integration_id, label, value, active)
        VALUES ('cred_1', 'opencode', 'default', '{"type":"key","key":"sk-test"}', 1);
      INSERT INTO session (id, title) VALUES ('ses_host', 'Host chat');
    `);
    hostSql.close();

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
});
