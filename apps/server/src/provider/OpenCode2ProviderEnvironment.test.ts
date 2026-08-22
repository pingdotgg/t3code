// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
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

// oxlint-disable-next-line t3code/no-global-process-runtime -- platform is only used to skip POSIX filesystem-mode assertions.
const isWindows = NodeOS.platform() === "win32";

describe("applyOpenCode2ProviderEnvironment", () => {
  it("scopes managed state to the host user", () => {
    const first = openCode2ManagedStateRoot({ TMPDIR: "/tmp/opencode2-root", HOME: "/home/alice" });
    const second = openCode2ManagedStateRoot({ TMPDIR: "/tmp/opencode2-root", HOME: "/home/bob" });
    expect(first).not.toBe(second);
    expect(first).toBe(
      openCode2ManagedStateRoot({ TMPDIR: "/tmp/opencode2-root", HOME: "/home/alice" }),
    );
  });

  it("isolates managed state roots per instance identity", () => {
    const environment = { TMPDIR: "/tmp/opencode2-instance-root", HOME: "/home/alice" };
    const first = openCode2ManagedStateRoot(environment, "opencode2-primary");
    const second = openCode2ManagedStateRoot(environment, "opencode2-secondary");
    const perUser = openCode2ManagedStateRoot(environment);

    expect(first).not.toBe(second);
    expect(first).not.toBe(perUser);
    expect(second).not.toBe(perUser);
    expect(first).toBe(openCode2ManagedStateRoot(environment, "opencode2-primary"));
    // Raw instance ids must not appear in the path; only a short hash does.
    expect(first).not.toContain("opencode2-primary");
    expect(second).not.toContain("opencode2-secondary");
  });

  it("isolates managed state roots per T3 environment identity", () => {
    const environment = { TMPDIR: "/tmp/opencode2-environment-root", HOME: "/home/alice" };
    const primary = openCode2ManagedStateRoot(
      environment,
      "opencode2-primary",
      "/home/alice/.t3/userdata",
    );
    const worktree = openCode2ManagedStateRoot(
      environment,
      "opencode2-primary",
      "/worktrees/t3code/.t3/userdata",
    );

    expect(primary).not.toBe(worktree);
    expect(primary).toBe(
      openCode2ManagedStateRoot(environment, "opencode2-primary", "/home/alice/.t3/userdata"),
    );
  });

  it("does not write through a planted managed-state symlink", () => {
    if (isWindows) return;
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-state-link-"));
    const stateRoot = openCode2ManagedStateRoot({ TMPDIR: tmp, HOME: "/home/test-user" }, "oc2");
    const target = NodePath.join(tmp, "outside");
    NodeFS.mkdirSync(target);
    NodeFS.symlinkSync(target, stateRoot, "dir");
    const environment = { TMPDIR: tmp, HOME: "/home/test-user" };

    const applied = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
    );

    expect(applied).not.toBe(environment);
    expect(applied.XDG_DATA_HOME).not.toContain(stateRoot);
    expect(applied.XDG_STATE_HOME).not.toContain(stateRoot);
    expect(NodeFS.readdirSync(target)).toEqual([]);
  });

  it("falls back when a managed-state child is a symlink", () => {
    if (isWindows) return;
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-child-link-"));
    const environment = { TMPDIR: tmp, HOME: "/home/test-user" };
    const stateRoot = openCode2ManagedStateRoot(environment, "oc2");
    const target = NodePath.join(tmp, "outside");
    NodeFS.mkdirSync(stateRoot, { recursive: true });
    NodeFS.mkdirSync(target);
    NodeFS.symlinkSync(target, NodePath.join(stateRoot, "state"), "dir");

    const first = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
    );
    const second = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
    );

    expect(first.XDG_STATE_HOME).not.toContain(stateRoot);
    expect(first.XDG_STATE_HOME).toBe(second.XDG_STATE_HOME);
    expect(first.XDG_STATE_HOME).toContain(tmp);
    expect(NodeFS.readdirSync(target)).toEqual([]);
  });

  it("adopts the legacy unkeyed managed state root without losing native sessions", () => {
    if (isWindows) return;
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-state-migrate-"));
    const environment = { TMPDIR: tmp, HOME: "/home/test-user" };
    const legacyRoot = NodePath.join(tmp, "t3-opencode2-state");
    const marker = NodePath.join(legacyRoot, "state", "resume-marker");
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "existing-session");

    const applied = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
    );
    const stateRoot = openCode2ManagedStateRoot(environment, "oc2");

    expect(applied.XDG_STATE_HOME).toBe(NodePath.join(stateRoot, "state"));
    expect(NodeFS.existsSync(legacyRoot)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(stateRoot, "state", "resume-marker"), "utf8")).toBe(
      "existing-session",
    );
  });

  it("adopts the previous per-user root once for the first instance only", () => {
    if (isWindows) return;
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-state-per-user-"));
    const environment = { TMPDIR: tmp, HOME: "/home/test-user" };
    const perUserRoot = openCode2ManagedStateRoot(environment);
    const marker = NodePath.join(perUserRoot, "state", "resume-marker");
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "per-user-session");

    const first = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "instance-a",
    );
    const second = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "instance-b",
    );
    const firstRoot = openCode2ManagedStateRoot(environment, "instance-a");
    const secondRoot = openCode2ManagedStateRoot(environment, "instance-b");

    expect(first.XDG_STATE_HOME).toBe(NodePath.join(firstRoot, "state"));
    expect(NodeFS.existsSync(perUserRoot)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(firstRoot, "state", "resume-marker"), "utf8")).toBe(
      "per-user-session",
    );
    expect(second.XDG_STATE_HOME).toBe(NodePath.join(secondRoot, "state"));
    expect(second.XDG_STATE_HOME).not.toBe(first.XDG_STATE_HOME);
    expect(NodeFS.existsSync(NodePath.join(secondRoot, "state", "resume-marker"))).toBe(false);
  });

  it("adopts the pre-environment root only for the default T3 home", () => {
    if (isWindows) return;
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-state-environment-"));
    const home = NodePath.join(tmp, "home");
    const environment = { TMPDIR: tmp, HOME: home };
    const previousRoot = openCode2ManagedStateRoot(environment, "oc2");
    const marker = NodePath.join(previousRoot, "state", "resume-marker");
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "primary-session");

    const worktreeIdentity = NodePath.join(tmp, "worktree", ".t3", "userdata");
    const worktree = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
      worktreeIdentity,
    );
    const worktreeRoot = openCode2ManagedStateRoot(environment, "oc2", worktreeIdentity);

    expect(worktree.XDG_STATE_HOME).toBe(NodePath.join(worktreeRoot, "state"));
    expect(NodeFS.existsSync(previousRoot)).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(worktreeRoot, "state", "resume-marker"))).toBe(false);

    const primaryIdentity = NodePath.join(home, ".t3", "userdata");
    const primary = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
      primaryIdentity,
    );
    const primaryRoot = openCode2ManagedStateRoot(environment, "oc2", primaryIdentity);

    expect(primary.XDG_STATE_HOME).toBe(NodePath.join(primaryRoot, "state"));
    expect(NodeFS.existsSync(previousRoot)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(primaryRoot, "state", "resume-marker"), "utf8")).toBe(
      "primary-session",
    );
  });

  it("gives concurrent instances distinct live data and state homes", () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-multi-instance-"));
    const environment = { TMPDIR: tmp, HOME: "/home/test-user" };

    const primary = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "primary",
    );
    const secondary = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "secondary",
    );

    expect(primary.XDG_DATA_HOME).not.toBe(secondary.XDG_DATA_HOME);
    expect(primary.XDG_STATE_HOME).not.toBe(secondary.XDG_STATE_HOME);
    expect(primary.XDG_DATA_HOME).toContain(tmp);
    expect(secondary.XDG_DATA_HOME).toContain(tmp);
  });

  it("explicitly enables background subagents for a managed server", () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-env-enabled-"));
    const environment = {
      HOME: NodePath.join(tmp, "home"),
      OPENCODE_EXPERIMENTAL: "false",
      TMPDIR: tmp,
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "false",
    };
    const env = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      environment,
      "oc2",
    );
    expect(env).toMatchObject({
      OPENCODE_EXPERIMENTAL: "false",
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "true",
    });
    const root = openCode2ManagedStateRoot(environment, "oc2");
    expect(env.XDG_STATE_HOME).toBe(NodePath.join(root, "state"));
    expect(env.XDG_DATA_HOME).toBe(NodePath.join(root, "data"));
    // Host config is preserved so user provider definitions still apply.
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it("explicitly disables background subagents even under the umbrella experiment", () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-env-disabled-"));
    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: false, serverUrl: "" },
        {
          HOME: NodePath.join(tmp, "home"),
          OPENCODE_EXPERIMENTAL: "true",
          TMPDIR: tmp,
        },
        "oc2",
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
        "oc2",
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

  it("preserves managed credentials when the host database temporarily disappears", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-missing-db-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(hostOpenCode, "auth.json"), "{}");
    writeHostOpenCodeDb(hostOpenCode, {
      credentials: [
        { id: "cred_1", integration_id: "opencode", label: "default", value: "secret" },
      ],
      withSession: false,
    });
    seedOpenCode2ManagedDataHome(managed, host);

    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "opencode.db"));
    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "auth.json"));
    seedOpenCode2ManagedDataHome(managed, host);

    const managedDb = new NodeSqlite.DatabaseSync(
      NodePath.join(managed, "opencode", "opencode.db"),
    );
    try {
      expect(managedDb.prepare("SELECT COUNT(*) AS n FROM credential").get()).toEqual({ n: 1 });
    } finally {
      managedDb.close();
    }
    expect(NodeFS.existsSync(NodePath.join(managed, "opencode", "auth.json"))).toBe(false);
  });

  it("keeps managed directories and files private", () => {
    if (isWindows) return;
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-mode-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(hostOpenCode, "auth.json"), "{}");
    writeHostOpenCodeDb(hostOpenCode, { credentials: [], withSession: false });
    seedOpenCode2ManagedDataHome(managed, host);

    expect(NodeFS.statSync(managed).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(NodePath.join(managed, "opencode")).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(NodePath.join(managed, "opencode", "auth.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(NodeFS.statSync(NodePath.join(managed, "opencode", "opencode.db")).mode & 0o777).toBe(
      0o600,
    );
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

  it("publishes the first managed database only after pruning sessions", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-atomic-"));
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
          value: '{"type":"key","key":"sk-test"}',
        },
      ],
    });

    seedOpenCode2ManagedDataHome(managed, host);

    const managedOpenCode = NodePath.join(managed, "opencode");
    const managedDbPath = NodePath.join(managedOpenCode, "opencode.db");
    expect(NodeFS.existsSync(managedDbPath)).toBe(true);
    // Temporary sibling snapshots must not remain after a successful seed.
    const leftoverTemps = NodeFS.readdirSync(managedOpenCode).filter(
      (name) => name.startsWith("opencode.db.") && name.endsWith(".tmp"),
    );
    expect(leftoverTemps).toEqual([]);

    const managedDb = new NodeSqlite.DatabaseSync(managedDbPath);
    try {
      expect(managedDb.prepare("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
      expect(managedDb.prepare("SELECT COUNT(*) AS n FROM credential").get()).toEqual({ n: 1 });
    } finally {
      managedDb.close();
    }
  });

  it("waits for a held SQLite publication lock before publishing", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-lock-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    const managedOpenCode = NodePath.join(managed, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.mkdirSync(managedOpenCode, { recursive: true });
    writeHostOpenCodeDb(hostOpenCode);
    const managedDbPath = NodePath.join(managedOpenCode, "opencode.db");
    const lockPath = `${managedDbPath}.publish.lock`;
    const violationPath = NodePath.join(root, "published-while-locked");
    const holder = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        [
          'const { DatabaseSync } = require("node:sqlite");',
          "const db = new DatabaseSync(process.argv[1]);",
          'db.exec("BEGIN EXCLUSIVE");',
          'process.stdout.write("locked\\n");',
          'setTimeout(() => { if (require("node:fs").existsSync(process.argv[2])) require("node:fs").writeFileSync(process.argv[3], "published"); db.exec("COMMIT"); db.close(); }, 250);',
        ].join(" "),
        lockPath,
        managedDbPath,
        violationPath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const holderExit = new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Lock holder exited with status ${String(code)}`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.setEncoding("utf8");
      holder.stdout.once("data", (output) => {
        if (String(output).includes("locked")) resolve();
        else reject(new Error(`Unexpected lock-holder output: ${String(output)}`));
      });
    });

    seedOpenCode2ManagedDataHome(managed, host);
    await holderExit;

    expect(NodeFS.existsSync(violationPath)).toBe(false);
    expect(NodeFS.existsSync(managedDbPath)).toBe(true);
    expect(NodeFS.existsSync(lockPath)).toBe(true);
    const publicationLock = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
    publicationLock.close();
  });

  it("does not publish when an existing session table cannot be pruned", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-prune-fail-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    writeHostOpenCodeDb(hostOpenCode);
    const hostDb = new NodeSqlite.DatabaseSync(NodePath.join(hostOpenCode, "opencode.db"));
    try {
      hostDb.exec(`
        CREATE TRIGGER block_session_delete
        BEFORE DELETE ON session
        BEGIN
          SELECT RAISE(ABORT, 'blocked');
        END;
      `);
    } finally {
      hostDb.close();
    }

    seedOpenCode2ManagedDataHome(managed, host);

    const managedOpenCode = NodePath.join(managed, "opencode");
    expect(NodeFS.existsSync(NodePath.join(managedOpenCode, "opencode.db"))).toBe(false);
    expect(
      NodeFS.readdirSync(managedOpenCode).filter(
        (name) => name.startsWith("opencode.db.") && name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("does not treat a leftover temporary database as initialized", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-stale-tmp-"));
    const host = NodePath.join(root, "host");
    const managed = NodePath.join(root, "managed");
    const hostOpenCode = NodePath.join(host, "opencode");
    const managedOpenCode = NodePath.join(managed, "opencode");
    NodeFS.mkdirSync(hostOpenCode, { recursive: true });
    NodeFS.mkdirSync(managedOpenCode, { recursive: true });
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

    // Simulate a crash after VACUUM INTO but before prune/publish: an unpruned
    // temporary sibling must never count as the final managed database.
    const staleTmp = NodePath.join(managedOpenCode, "opencode.db.999999.deadbeefdeadbeef.tmp");
    NodeFS.copyFileSync(NodePath.join(hostOpenCode, "opencode.db"), staleTmp);
    NodeFS.chmodSync(staleTmp, 0o600);
    const staleSidecars = ["-journal", "-shm", "-wal"].map((suffix) => `${staleTmp}${suffix}`);
    for (const sidecar of staleSidecars) {
      NodeFS.writeFileSync(sidecar, "unpruned host snapshot");
      NodeFS.chmodSync(sidecar, 0o600);
    }
    const liveTmp = NodePath.join(
      managedOpenCode,
      `opencode.db.${process.pid}.feedfacefeedface.tmp`,
    );
    const liveSidecar = `${liveTmp}-journal`;
    NodeFS.writeFileSync(liveTmp, "live publisher");
    NodeFS.writeFileSync(liveSidecar, "live publisher journal");
    NodeFS.chmodSync(liveTmp, 0o600);
    NodeFS.chmodSync(liveSidecar, 0o600);
    const stale = new NodeSqlite.DatabaseSync(staleTmp);
    try {
      expect(stale.prepare("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 1 });
    } finally {
      stale.close();
    }

    seedOpenCode2ManagedDataHome(managed, host);

    const managedDbPath = NodePath.join(managedOpenCode, "opencode.db");
    expect(NodeFS.existsSync(staleTmp)).toBe(false);
    expect(staleSidecars.every((sidecar) => !NodeFS.existsSync(sidecar))).toBe(true);
    expect(NodeFS.existsSync(liveTmp)).toBe(true);
    expect(NodeFS.existsSync(liveSidecar)).toBe(true);
    expect(NodeFS.existsSync(managedDbPath)).toBe(true);
    const managedDb = new NodeSqlite.DatabaseSync(managedDbPath);
    try {
      expect(managedDb.prepare("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
      expect(managedDb.prepare("SELECT id FROM credential").all()).toEqual([{ id: "cred_1" }]);
    } finally {
      managedDb.close();
    }
  });

  it("keeps the published database inode during credential refresh", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-seed-concurrent-"));
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
          value: '{"type":"key","key":"sk-first"}',
        },
      ],
    });
    seedOpenCode2ManagedDataHome(managed, host);

    const managedDbPath = NodePath.join(managed, "opencode", "opencode.db");
    const before = NodeFS.statSync(managedDbPath);

    // A second seed sees an existing managed DB and refreshes credentials only.
    NodeFS.unlinkSync(NodePath.join(hostOpenCode, "opencode.db"));
    for (const suffix of ["-wal", "-shm"] as const) {
      try {
        NodeFS.unlinkSync(NodePath.join(hostOpenCode, `opencode.db${suffix}`));
      } catch {
        // Optional.
      }
    }
    writeHostOpenCodeDb(hostOpenCode, {
      credentials: [
        {
          id: "cred_2",
          integration_id: "opencode",
          label: "default",
          value: '{"type":"key","key":"sk-second"}',
        },
      ],
      withSession: false,
    });
    seedOpenCode2ManagedDataHome(managed, host);

    const after = NodeFS.statSync(managedDbPath);
    expect(after.ino).toBe(before.ino);
    const managedDb = new NodeSqlite.DatabaseSync(managedDbPath);
    try {
      expect(managedDb.prepare("SELECT id FROM credential").all()).toEqual([{ id: "cred_2" }]);
      expect(managedDb.prepare("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
    } finally {
      managedDb.close();
    }
  });
});
