// A dummy app Postgres for the lab: what the desktop shell's databaseRun answers to the real Database
// panel (labDesktopBridge.ts). Tables with 30 deterministic rows each; nothing here reaches a server.
import type {
  DesktopDatabaseColumn,
  DesktopDatabaseRequest,
  DesktopDatabaseResponse,
} from "@t3tools/contracts";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;

interface LabTable {
  readonly name: string;
  readonly columns: ReadonlyArray<DesktopDatabaseColumn>;
  readonly rows: ReadonlyArray<Row>;
}

const ROWS = 30;
const NOW = Date.UTC(2026, 10, 20, 21, 30, 0);

/** A small seeded generator, so the grid shows the same rows on every load. */
function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    pick: <T>(values: ReadonlyArray<T>): T => values[Math.floor(next() * values.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rand = ReturnType<typeof seeded>;

const hex = (rand: Rand, length: number) =>
  Array.from({ length }, () => "0123456789abcdef"[rand.int(0, 15)]).join("");
const uuid = (rand: Rand) =>
  `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;
const ago = (rand: Rand, maxDays: number) =>
  `${new Date(NOW - rand.int(1, maxDays * 24 * 60) * 60_000).toISOString().replace("T", " ").slice(0, 19)}+00`;

const FIRST = [
  "Nick",
  "Sofia",
  "Jules",
  "Amara",
  "Ravi",
  "Mei",
  "Tomas",
  "Ingrid",
  "Karim",
  "Lena",
];
const LAST = ["Kruiswijk", "Bianchi", "Okafor", "Lindqvist", "Nakamura", "Duarte", "Haddad"];
const TITLES = [
  "Fix the flaky sync tests",
  "Tasks board polish",
  "Plan image attachments in the composer",
  "Gateway task insights runs out of memory",
  "Move Orbit workers to target nodes",
  "Thread search across environments",
  "Offline drafts on iOS",
  "Usage limits per provider",
  "Desktop auto-update channel",
];
const STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"];

const column = (
  name: string,
  type: string,
  options: { primary?: boolean; nullable?: boolean; default?: string } = {},
): DesktopDatabaseColumn => ({
  name,
  type,
  nullable: options.nullable ?? false,
  default: options.default ?? null,
  primary: options.primary ?? false,
});

function table(
  name: string,
  columns: ReadonlyArray<DesktopDatabaseColumn>,
  make: (rand: Rand, index: number) => ReadonlyArray<Cell>,
): LabTable {
  const rand = seeded(name.length * 7919 + 17);
  const rows = Array.from({ length: ROWS }, (_, index) => {
    const values = make(rand, index);
    return Object.fromEntries(
      columns.map((item, position) => [item.name, values[position] ?? null]),
    );
  });
  return { name, columns, rows };
}

const TABLES: ReadonlyArray<LabTable> = [
  table(
    "users",
    [
      column("id", "uuid", { primary: true, default: "gen_random_uuid()" }),
      column("email", "text"),
      column("name", "text"),
      column("role", "text", { default: "'member'::text" }),
      column("is_active", "boolean", { default: "true" }),
      column("created_at", "timestamp with time zone", { default: "now()" }),
      column("last_seen_at", "timestamp with time zone", { nullable: true }),
    ],
    (rand) => {
      const first = rand.pick(FIRST);
      const last = rand.pick(LAST);
      return [
        uuid(rand),
        `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        `${first} ${last}`,
        rand.pick(["member", "member", "member", "admin", "owner"]),
        rand.chance(0.9),
        ago(rand, 900),
        rand.chance(0.2) ? null : ago(rand, 20),
      ];
    },
  ),
  table(
    "projects",
    [
      column("id", "integer", { primary: true, default: "nextval('projects_id_seq'::regclass)" }),
      column("slug", "text"),
      column("name", "text"),
      column("owner_id", "uuid"),
      column("repo_url", "text", { nullable: true }),
      column("default_branch", "text", { default: "'main'::text" }),
      column("created_at", "timestamp with time zone", { default: "now()" }),
    ],
    (rand, index) => {
      const slug = `${rand.pick(["conn", "orbit", "operator", "vault", "mealou", "hauzer"])}-${index + 1}`;
      return [
        index + 1,
        slug,
        slug.replace("-", " "),
        uuid(rand),
        rand.chance(0.15) ? null : `https://github.com/nckrtl/${slug}`,
        rand.pick(["main", "main", "main", "develop"]),
        ago(rand, 700),
      ];
    },
  ),
  table(
    "threads",
    [
      column("id", "uuid", { primary: true }),
      column("project_id", "integer"),
      column("title", "text"),
      column("provider", "text"),
      column("model", "text"),
      column("status", "text"),
      column("created_at", "timestamp with time zone", { default: "now()" }),
      column("archived_at", "timestamp with time zone", { nullable: true }),
    ],
    (rand) => {
      const provider = rand.pick(["claudeAgent", "codex", "codex", "cursor"]);
      return [
        uuid(rand),
        rand.int(1, 30),
        rand.pick(TITLES),
        provider,
        provider === "claudeAgent" ? rand.pick(["opus-5-5", "sonnet-5-5"]) : "gpt-5.4",
        rand.pick(["idle", "idle", "running", "waiting", "failed"]),
        ago(rand, 120),
        rand.chance(0.35) ? ago(rand, 30) : null,
      ];
    },
  ),
  table(
    "tasks",
    [
      column("id", "integer", { primary: true, default: "nextval('tasks_id_seq'::regclass)" }),
      column("project_id", "integer"),
      column("title", "text"),
      column("status", "text", { default: "'todo'::text" }),
      column("priority", "integer", { default: "0" }),
      column("assignee_id", "uuid", { nullable: true }),
      column("pr_number", "integer", { nullable: true }),
      column("created_at", "timestamp with time zone", { default: "now()" }),
    ],
    (rand, index) => [
      400 + index * 3 + rand.int(0, 2),
      rand.int(1, 30),
      rand.pick(TITLES),
      rand.pick(STATUSES),
      rand.int(0, 4),
      rand.chance(0.3) ? null : uuid(rand),
      rand.chance(0.45) ? null : rand.int(1850, 1940),
      ago(rand, 60),
    ],
  ),
  table(
    "subtasks",
    [
      column("id", "integer", { primary: true }),
      column("task_id", "integer"),
      column("position", "integer"),
      column("title", "text"),
      column("status", "text"),
      column("started_at", "timestamp with time zone", { nullable: true }),
    ],
    (rand, index) => [
      5000 + index,
      400 + rand.int(0, 30) * 3,
      (index % 4) + 1,
      rand.pick([
        "Write the failing test",
        "Implement the change",
        "Review the diff",
        "Run check:changed",
      ]),
      rand.pick(STATUSES),
      rand.chance(0.3) ? null : ago(rand, 30),
    ],
  ),
  table(
    "runs",
    [
      column("id", "uuid", { primary: true }),
      column("thread_id", "uuid"),
      column("status", "text"),
      column("tokens_in", "integer"),
      column("tokens_out", "integer"),
      column("cost_usd", "numeric(10,4)"),
      column("started_at", "timestamp with time zone"),
      column("ended_at", "timestamp with time zone", { nullable: true }),
    ],
    (rand) => {
      const tokensIn = rand.int(2_000, 2_400_000);
      const tokensOut = rand.int(300, 180_000);
      return [
        uuid(rand),
        uuid(rand),
        rand.pick(["completed", "completed", "completed", "interrupted", "failed"]),
        tokensIn,
        tokensOut,
        Number((tokensIn * 0.000003 + tokensOut * 0.000015).toFixed(4)),
        ago(rand, 45),
        rand.chance(0.08) ? null : ago(rand, 40),
      ];
    },
  ),
  table(
    "messages",
    [
      column("id", "bigint", { primary: true }),
      column("thread_id", "uuid"),
      column("role", "text"),
      column("body", "text"),
      column("tokens", "integer"),
      column("created_at", "timestamp with time zone", { default: "now()" }),
    ],
    (rand, index) => [
      612_000 + index,
      uuid(rand),
      rand.pick(["user", "assistant", "assistant", "tool"]),
      rand.pick([
        "Plan the change, then run the tests.",
        "I found the flakiness.",
        "Both tasks are in Orbit.",
      ]),
      rand.int(12, 4_200),
      ago(rand, 14),
    ],
  ),
  table(
    "environments",
    [
      column("id", "uuid", { primary: true }),
      column("name", "text"),
      column("kind", "text"),
      column("host", "inet"),
      column("connected", "boolean", { default: "false" }),
      column("last_heartbeat_at", "timestamp with time zone", { nullable: true }),
    ],
    (rand, index) => [
      uuid(rand),
      `${rand.pick(["MacBook", "Linux VM", "beast", "mini", "task-vm"])}-${index + 1}`,
      rand.pick(["desktop", "server", "container"]),
      `10.0.${rand.int(0, 8)}.${rand.int(2, 250)}`,
      rand.chance(0.7),
      rand.chance(0.25) ? null : ago(rand, 2),
    ],
  ),
  table(
    "api_tokens",
    [
      column("id", "integer", { primary: true }),
      column("user_id", "uuid"),
      column("name", "text"),
      column("scopes", "jsonb"),
      column("last_used_at", "timestamp with time zone", { nullable: true }),
      column("expires_at", "timestamp with time zone", { nullable: true }),
    ],
    (rand, index) => [
      index + 1,
      uuid(rand),
      rand.pick(["CI runner", "Mobile lab", "Desktop sync", "Agent MCP"]),
      JSON.stringify(
        rand.pick([["read"], ["read", "orchestrate"], ["read", "write", "orchestrate"]]),
      ),
      rand.chance(0.3) ? null : ago(rand, 10),
      rand.chance(0.6) ? null : ago(rand, 200),
    ],
  ),
  table(
    "audit_log",
    [
      column("id", "bigint", { primary: true }),
      column("actor_id", "uuid", { nullable: true }),
      column("action", "text"),
      column("target", "text"),
      column("ip", "inet", { nullable: true }),
      column("created_at", "timestamp with time zone", { default: "now()" }),
    ],
    (rand, index) => [
      128_800 + index,
      rand.chance(0.12) ? null : uuid(rand),
      rand.pick(["thread.create", "task.update", "token.revoke", "env.pair", "settings.update"]),
      `${rand.pick(["thread", "task", "token", "environment", "settings"])}:${rand.int(1, 9999)}`,
      rand.chance(0.15) ? null : `192.168.${rand.int(0, 3)}.${rand.int(2, 250)}`,
      ago(rand, 5),
    ],
  ),
  table(
    "migrations",
    [
      column("id", "integer", { primary: true }),
      column("name", "text"),
      column("batch", "integer"),
      column("ran_at", "timestamp with time zone"),
    ],
    (rand, index) => [
      index + 1,
      `2026_${String(rand.int(1, 11)).padStart(2, "0")}_${String(rand.int(1, 28)).padStart(2, "0")}_create_${rand.pick(["threads", "runs", "tasks", "tokens", "audit"])}_table`,
      Math.floor(index / 5) + 1,
      ago(rand, 400),
    ],
  ),
  table(
    "settings",
    [
      column("key", "text", { primary: true }),
      column("value", "jsonb"),
      column("updated_by", "uuid", { nullable: true }),
      column("updated_at", "timestamp with time zone", { default: "now()" }),
    ],
    (rand, index) => [
      `${rand.pick(["ui", "agents", "sync", "limits"])}.${rand.pick(["theme", "default_model", "retention_days", "max_runs"])}_${index}`,
      JSON.stringify(
        rand.pick([{ enabled: true }, { value: 30 }, { value: "dark" }, { list: ["a", "b"] }]),
      ),
      rand.chance(0.4) ? null : uuid(rand),
      ago(rand, 120),
    ],
  ),
];

const empty = (): DesktopDatabaseResponse => ({
  error: null,
  tables: [],
  columns: [],
  resultColumns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  durationMs: 3,
});

const tableOf = (name: string | undefined) =>
  TABLES.find((candidate) => candidate.name === (name ?? "").replace(/^public\./, ""));

/** The desktop shell's databaseRun, answering from the dummy tables. */
export function labDatabaseRun(request: DesktopDatabaseRequest): DesktopDatabaseResponse {
  if (request.operation === "tables") {
    return { ...empty(), tables: TABLES.map((item) => item.name).toSorted() };
  }
  if (request.operation === "describe") {
    return { ...empty(), columns: tableOf(request.table)?.columns ?? [] };
  }
  // The panel browses with `select * from "<table>" limit 100`; the lab answers any select that names one.
  const sql = request.sql ?? "";
  const name = /\bfrom\s+(?:"([^"]+)"|([\w.]+))/i.exec(sql);
  const found = tableOf(name?.[1] ?? name?.[2]);
  if (!found) {
    return {
      ...empty(),
      error:
        "The lab database only answers select statements on its tables: " +
        TABLES.map((item) => item.name).join(", "),
    };
  }
  const limit = Number(/\blimit\s+(\d+)/i.exec(sql)?.[1] ?? 100);
  const rows = found.rows.slice(0, limit);
  return {
    ...empty(),
    resultColumns: found.columns.map((item) => item.name),
    rows,
    rowCount: rows.length,
  };
}
