/**
 * Phase 0 G9 probe (disposable experiment, not feature implementation).
 *
 * Exercises the configuration invariants that must be feasible before the
 * production schema/API exists: versioned exact imports, env -> project
 * inheritance, revision conflicts, weighted-pool validation, stable assignment
 * snapshots, preview/apply reassignment, and non-destructive ceiling changes.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_WEIGHT = 1_000_000;
const MAX_NAME_ENTRIES = 10_000;
const MAX_PROFILE_ENTRIES = 100;
const MAX_POOLS = 16;
const MAX_PACKET_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_NOTE_BYTES = 8 * 1024;
const MAX_RETAINED_BODY_BYTES = 128 * 1024 * 1024;

const WeightedNameEntry = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  weight: Schema.Number,
});
const WeightedProfileEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  styleText: Schema.String,
  weight: Schema.Number,
});
const NamePool = Schema.Struct({ id: Schema.String, entries: Schema.Array(WeightedNameEntry) });
const ProfilePool = Schema.Struct({
  id: Schema.String,
  entries: Schema.Array(WeightedProfileEntry),
});

const CivilizationConfig = Schema.Struct({
  version: Schema.Literal(1),
  participation: Schema.Struct({
    enabled: Schema.Boolean,
    emergencyOff: Schema.Boolean,
    adoption: Schema.Literals(["all_existing", "future_only"]),
    includeControllableChildren: Schema.Boolean,
    showObservedAgents: Schema.Boolean,
  }),
  names: Schema.Struct({
    pools: Schema.Array(NamePool),
    selectedPoolId: Schema.String,
    titleTemplate: Schema.String,
    automaticTitles: Schema.Boolean,
    adoptionTitlePolicy: Schema.Literals(["preserve", "managed"]),
  }),
  personalities: Schema.Struct({
    pools: Schema.Array(ProfilePool),
    selectedPoolId: Schema.String,
    rendering: Schema.Literals(["off", "mild"]),
  }),
  knowledge: Schema.Struct({
    noteCategories: Schema.Array(Schema.String),
    noteBytes: Schema.Number,
    activeNotes: Schema.Number,
    retentionDays: Schema.Number,
    packetInclusion: Schema.Boolean,
    ancestorReads: Schema.Boolean,
    showGeneration: Schema.Boolean,
  }),
  context: Schema.Struct({
    packetBytes: Schema.Number,
    rosterCount: Schema.Number,
    noteCount: Schema.Number,
    inboxExcerptCount: Schema.Number,
    selection: Schema.Literals(["recent", "stable_id"]),
  }),
  messaging: Schema.Struct({
    enabled: Schema.Boolean,
    allowControllableChildren: Schema.Boolean,
    messageBytes: Schema.Number,
    pendingPerRecipient: Schema.Number,
    senderPerMinute: Schema.Number,
    projectPerMinute: Schema.Number,
    retainedMessageCount: Schema.Number,
    retainedBodyBytes: Schema.Number,
    unreadTtlDays: Schema.Number,
    repliesEnabled: Schema.Boolean,
  }),
  operations: Schema.Struct({
    terminalRetentionDays: Schema.Number,
    diagnosticRetentionDays: Schema.Number,
    tombstoneRetentionDays: Schema.Number,
    cleanupCadenceMinutes: Schema.Number,
    cleanupBatch: Schema.Number,
    diagnostics: Schema.Literals(["off", "errors", "normal"]),
  }),
});
type CivilizationConfig = typeof CivilizationConfig.Type;

const ProjectOverride = Schema.Struct({
  version: Schema.Literal(1),
  names: Schema.optional(
    Schema.Struct({
      selectedPoolId: Schema.optional(Schema.String),
      titleTemplate: Schema.optional(Schema.String),
    }),
  ),
  personalities: Schema.optional(
    Schema.Struct({
      selectedPoolId: Schema.optional(Schema.String),
      rendering: Schema.optional(Schema.Literals(["off", "mild"])),
    }),
  ),
  messaging: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      messageBytes: Schema.optional(Schema.Number),
      retainedMessageCount: Schema.optional(Schema.Number),
      retainedBodyBytes: Schema.optional(Schema.Number),
    }),
  ),
});
type ProjectOverride = typeof ProjectOverride.Type;

class ProbeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const exactKeys = (value: unknown, allowed: ReadonlySet<string>, path: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProbeConfigError("invalid_config", `${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProbeConfigError("unknown_field", `Unknown field ${path}.${key}`);
    }
  }
};

const hasUnsafeFormatting = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");

type Mutable<T> =
  T extends ReadonlyArray<infer Item>
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

const mutableClone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;

function assertIntegerRange(value: number, min: number, max: number, path: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProbeConfigError("invalid_limit", `${path} must be an integer in [${min}, ${max}]`);
  }
}

function validateTitleTemplate(template: string) {
  if (byteLength(template) > 512 || hasUnsafeFormatting(template)) {
    throw new ProbeConfigError("invalid_title_template", "Title template is too large or unsafe");
  }
  const placeholders = [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  if (placeholders.some((placeholder) => !["name", "topic", "generation"].includes(placeholder))) {
    throw new ProbeConfigError("invalid_title_template", "Unsupported title placeholder");
  }
  if (placeholders.filter((placeholder) => placeholder === "name").length !== 1) {
    throw new ProbeConfigError(
      "invalid_title_template",
      "Managed titles require {name} exactly once",
    );
  }
}

function validateWeight(weight: number, path: string) {
  assertIntegerRange(weight, 0, MAX_ENTRY_WEIGHT, path);
}

function validateNamePool(pool: (typeof NamePool)["Type"]) {
  if (pool.entries.length > MAX_NAME_ENTRIES) {
    throw new ProbeConfigError("limit", `Name pool ${pool.id} exceeds ${MAX_NAME_ENTRIES} entries`);
  }
  const ids = new Set<string>();
  const displayNames = new Set<string>();
  let total = 0;
  for (const entry of pool.entries) {
    validateWeight(entry.weight, `names.${pool.id}.${entry.id}.weight`);
    if (ids.has(entry.id))
      throw new ProbeConfigError("duplicate_id", `Duplicate name id ${entry.id}`);
    ids.add(entry.id);
    const key = normalized(entry.displayName);
    if (displayNames.has(key)) {
      throw new ProbeConfigError(
        "duplicate_name",
        `Duplicate normalized name ${entry.displayName}`,
      );
    }
    displayNames.add(key);
    if (byteLength(entry.displayName) > 128 || hasUnsafeFormatting(entry.displayName)) {
      throw new ProbeConfigError("invalid_name", `Invalid name ${entry.id}`);
    }
    total += entry.weight;
    if (!Number.isSafeInteger(total)) throw new ProbeConfigError("unsafe_weight_total", pool.id);
  }
  return total;
}

function validateProfilePool(pool: (typeof ProfilePool)["Type"]) {
  if (pool.entries.length > MAX_PROFILE_ENTRIES) {
    throw new ProbeConfigError(
      "limit",
      `Profile pool ${pool.id} exceeds ${MAX_PROFILE_ENTRIES} entries`,
    );
  }
  const ids = new Set<string>();
  let total = 0;
  for (const entry of pool.entries) {
    validateWeight(entry.weight, `profiles.${pool.id}.${entry.id}.weight`);
    if (ids.has(entry.id))
      throw new ProbeConfigError("duplicate_id", `Duplicate profile id ${entry.id}`);
    ids.add(entry.id);
    if (byteLength(entry.styleText) > 512 || hasUnsafeFormatting(entry.label)) {
      throw new ProbeConfigError("invalid_profile", `Invalid profile ${entry.id}`);
    }
    total += entry.weight;
    if (!Number.isSafeInteger(total)) throw new ProbeConfigError("unsafe_weight_total", pool.id);
  }
  return total;
}

function validateConfigSemantics(config: CivilizationConfig) {
  if (config.names.pools.length > MAX_POOLS || config.personalities.pools.length > MAX_POOLS) {
    throw new ProbeConfigError("limit", `Pool count exceeds ${MAX_POOLS}`);
  }
  const nameIds = new Set<string>();
  const nameTotals = new Map<string, number>();
  for (const pool of config.names.pools) {
    if (nameIds.has(pool.id))
      throw new ProbeConfigError("duplicate_id", `Duplicate name pool ${pool.id}`);
    nameIds.add(pool.id);
    nameTotals.set(pool.id, validateNamePool(pool));
  }
  const profileIds = new Set<string>();
  const profileTotals = new Map<string, number>();
  for (const pool of config.personalities.pools) {
    if (profileIds.has(pool.id)) {
      throw new ProbeConfigError("duplicate_id", `Duplicate profile pool ${pool.id}`);
    }
    profileIds.add(pool.id);
    profileTotals.set(pool.id, validateProfilePool(pool));
  }
  if ((nameTotals.get(config.names.selectedPoolId) ?? 0) <= 0) {
    throw new ProbeConfigError(
      "invalid_pool_reference",
      "Selected name pool has no positive weight",
    );
  }
  if ((profileTotals.get(config.personalities.selectedPoolId) ?? 0) <= 0) {
    // Required even while rendering is off: assignment snapshots still draw a profile.
    throw new ProbeConfigError(
      "invalid_pool_reference",
      "Selected profile pool has no positive weight",
    );
  }
  validateTitleTemplate(config.names.titleTemplate);
  assertIntegerRange(config.knowledge.noteBytes, 0, MAX_NOTE_BYTES, "knowledge.noteBytes");
  assertIntegerRange(config.knowledge.activeNotes, 0, 2_000, "knowledge.activeNotes");
  assertIntegerRange(config.knowledge.retentionDays, 0, 365, "knowledge.retentionDays");
  assertIntegerRange(config.context.packetBytes, 0, MAX_PACKET_BYTES, "context.packetBytes");
  assertIntegerRange(config.context.rosterCount, 0, 50, "context.rosterCount");
  assertIntegerRange(config.context.noteCount, 0, 10, "context.noteCount");
  assertIntegerRange(config.context.inboxExcerptCount, 0, 20, "context.inboxExcerptCount");
  assertIntegerRange(config.messaging.messageBytes, 0, MAX_MESSAGE_BYTES, "messaging.messageBytes");
  assertIntegerRange(
    config.messaging.pendingPerRecipient,
    0,
    1_000,
    "messaging.pendingPerRecipient",
  );
  assertIntegerRange(config.messaging.senderPerMinute, 0, 60, "messaging.senderPerMinute");
  assertIntegerRange(config.messaging.projectPerMinute, 0, 1_000, "messaging.projectPerMinute");
  assertIntegerRange(
    config.messaging.retainedMessageCount,
    0,
    100_000,
    "messaging.retainedMessageCount",
  );
  assertIntegerRange(
    config.messaging.retainedBodyBytes,
    0,
    MAX_RETAINED_BODY_BYTES,
    "messaging.retainedBodyBytes",
  );
  assertIntegerRange(config.messaging.unreadTtlDays, 0, 365, "messaging.unreadTtlDays");
  assertIntegerRange(
    config.operations.terminalRetentionDays,
    0,
    365,
    "operations.terminalRetentionDays",
  );
  assertIntegerRange(
    config.operations.diagnosticRetentionDays,
    0,
    30,
    "operations.diagnosticRetentionDays",
  );
  assertIntegerRange(
    config.operations.tombstoneRetentionDays,
    0,
    365,
    "operations.tombstoneRetentionDays",
  );
  assertIntegerRange(
    config.operations.cleanupCadenceMinutes,
    1,
    60 * 24 * 365,
    "operations.cleanupCadenceMinutes",
  );
  assertIntegerRange(config.operations.cleanupBatch, 1, 1_000, "operations.cleanupBatch");
  return config;
}

const configTopKeys = new Set([
  "version",
  "participation",
  "names",
  "personalities",
  "knowledge",
  "context",
  "messaging",
  "operations",
]);
const overrideTopKeys = new Set(["version", "names", "personalities", "messaging"]);
const decodeConfigSync = Schema.decodeUnknownSync(CivilizationConfig);
const decodeOverrideSync = Schema.decodeUnknownSync(ProjectOverride);

function parseConfigUnsafe(input: unknown): CivilizationConfig {
  exactKeys(input, configTopKeys, "config");
  const encodedBytes = byteLength(JSON.stringify(input));
  if (encodedBytes > MAX_IMPORT_BYTES) throw new ProbeConfigError("limit", "Config exceeds 2 MiB");
  const decoded = decodeConfigSync(input);
  return validateConfigSemantics(decoded);
}

function parseOverrideUnsafe(input: unknown): ProjectOverride {
  exactKeys(input, overrideTopKeys, "override");
  return decodeOverrideSync(input);
}

const parseConfig = (input: unknown) =>
  Effect.try({
    try: () => parseConfigUnsafe(input),
    catch: (cause) =>
      cause instanceof ProbeConfigError
        ? cause
        : new ProbeConfigError("invalid_config", String(cause)),
  });

const parseOverride = (input: unknown) =>
  Effect.try({
    try: () => parseOverrideUnsafe(input),
    catch: (cause) =>
      cause instanceof ProbeConfigError
        ? cause
        : new ProbeConfigError("invalid_config", String(cause)),
  });

const defaultConfig = (): CivilizationConfig => ({
  version: 1,
  participation: {
    enabled: false,
    emergencyOff: false,
    adoption: "future_only",
    includeControllableChildren: true,
    showObservedAgents: true,
  },
  names: {
    pools: [
      {
        id: "names-main",
        entries: [
          { id: "name-ada", displayName: "Ada", weight: 6 },
          { id: "name-grace", displayName: "Grace", weight: 3 },
          { id: "name-linus", displayName: "Linus", weight: 1 },
        ],
      },
      {
        id: "names-alt",
        entries: [{ id: "name-margaret", displayName: "Margaret", weight: 1 }],
      },
    ],
    selectedPoolId: "names-main",
    titleTemplate: "[{name}] {topic}",
    automaticTitles: true,
    adoptionTitlePolicy: "preserve",
  },
  personalities: {
    pools: [
      {
        id: "profiles-main",
        entries: [
          { id: "profile-calm", label: "Calm", styleText: "calm and concise", weight: 3 },
          {
            id: "profile-curious",
            label: "Curious",
            styleText: "curious but restrained",
            weight: 1,
          },
        ],
      },
      {
        id: "profiles-alt",
        entries: [{ id: "profile-neutral", label: "Neutral", styleText: "neutral", weight: 1 }],
      },
    ],
    selectedPoolId: "profiles-main",
    rendering: "off",
  },
  knowledge: {
    noteCategories: ["fact", "preference"],
    noteBytes: 2 * 1024,
    activeNotes: 200,
    retentionDays: 30,
    packetInclusion: true,
    ancestorReads: true,
    showGeneration: true,
  },
  context: {
    packetBytes: 6 * 1024,
    rosterCount: 10,
    noteCount: 3,
    inboxExcerptCount: 5,
    selection: "recent",
  },
  messaging: {
    enabled: true,
    allowControllableChildren: true,
    messageBytes: 4 * 1024,
    pendingPerRecipient: 100,
    senderPerMinute: 10,
    projectPerMinute: 100,
    retainedMessageCount: 10_000,
    retainedBodyBytes: 32 * 1024 * 1024,
    unreadTtlDays: 30,
    repliesEnabled: true,
  },
  operations: {
    terminalRetentionDays: 30,
    diagnosticRetentionDays: 7,
    tombstoneRetentionDays: 30,
    cleanupCadenceMinutes: 60,
    cleanupBatch: 100,
    diagnostics: "normal",
  },
});

function resolveEffective(
  env: CivilizationConfig,
  override: ProjectOverride | null,
): CivilizationConfig {
  if (override === null) return env;
  return validateConfigSemantics({
    ...env,
    names: {
      ...env.names,
      ...(override.names?.selectedPoolId === undefined
        ? {}
        : { selectedPoolId: override.names.selectedPoolId }),
      ...(override.names?.titleTemplate === undefined
        ? {}
        : { titleTemplate: override.names.titleTemplate }),
    },
    personalities: {
      ...env.personalities,
      ...(override.personalities?.selectedPoolId === undefined
        ? {}
        : { selectedPoolId: override.personalities.selectedPoolId }),
      ...(override.personalities?.rendering === undefined
        ? {}
        : { rendering: override.personalities.rendering }),
    },
    messaging: {
      ...env.messaging,
      ...(override.messaging?.enabled === undefined ? {} : { enabled: override.messaging.enabled }),
      ...(override.messaging?.messageBytes === undefined
        ? {}
        : { messageBytes: override.messaging.messageBytes }),
      ...(override.messaging?.retainedMessageCount === undefined
        ? {}
        : { retainedMessageCount: override.messaging.retainedMessageCount }),
      ...(override.messaging?.retainedBodyBytes === undefined
        ? {}
        : { retainedBodyBytes: override.messaging.retainedBodyBytes }),
    },
  });
}

function weightedEntry<Entry extends { readonly id: string; readonly weight: number }>(
  entries: ReadonlyArray<Entry>,
  draw: number,
): Entry {
  const ordered = [...entries].toSorted((left, right) => left.id.localeCompare(right.id));
  const total = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isSafeInteger(draw) || draw < 0 || draw >= total) {
    throw new ProbeConfigError("invalid_draw", `Draw ${draw} outside [0, ${total})`);
  }
  let cursor = 0;
  for (const entry of ordered) {
    const end = cursor + entry.weight;
    if (draw >= cursor && draw < end) return entry;
    cursor = end;
  }
  throw new ProbeConfigError("invalid_draw", "No weighted entry selected");
}

type EnvRow = { readonly revision: number; readonly config_json: string };
type OverrideRow = {
  readonly project_id: string;
  readonly revision: number;
  readonly override_json: string;
};
type CitizenRow = {
  readonly thread_id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly name_entry_id: string;
  readonly profile_entry_id: string;
  readonly display_name: string;
  readonly profile_label: string;
};

const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_g9_environment (
    environment_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    config_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_g9_project_override (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    override_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_g9_citizen (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    name_entry_id TEXT NOT NULL,
    profile_entry_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_label TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_g9_usage (
    project_id TEXT PRIMARY KEY,
    message_count INTEGER NOT NULL,
    body_bytes INTEGER NOT NULL
  )`;
});

const environmentId = "environment:g9";

const seedEnvironment = (config = defaultConfig()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureSchema;
    yield* parseConfig(config);
    yield* sql`INSERT INTO civilization_g9_environment (environment_id, revision, config_json)
      VALUES (${environmentId}, 1, ${JSON.stringify(config)})`;
  });

const loadEnvironment = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<EnvRow>`SELECT revision, config_json FROM civilization_g9_environment
    WHERE environment_id = ${environmentId}`;
  const row = rows[0];
  if (row === undefined)
    return yield* Effect.fail(new ProbeConfigError("missing", "Environment missing"));
  return { revision: row.revision, config: parseConfigUnsafe(JSON.parse(row.config_json)) };
});

const loadProjectOverride = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<OverrideRow>`SELECT project_id, revision, override_json
      FROM civilization_g9_project_override WHERE project_id = ${projectId}`;
    const row = rows[0];
    return row === undefined
      ? null
      : { revision: row.revision, override: parseOverrideUnsafe(JSON.parse(row.override_json)) };
  });

const setProjectOverride = (input: {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly value: unknown;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const value = yield* parseOverride(input.value);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const env = yield* loadEnvironment;
        const current = yield* loadProjectOverride(input.projectId);
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== input.expectedRevision) {
          return yield* Effect.fail(
            new ProbeConfigError("revision_conflict", "Project revision changed"),
          );
        }
        yield* Effect.try({
          try: () => resolveEffective(env.config, value),
          catch: (cause) =>
            cause instanceof ProbeConfigError
              ? cause
              : new ProbeConfigError("invalid_config", String(cause)),
        });
        const revision = currentRevision + 1;
        yield* sql`INSERT INTO civilization_g9_project_override (project_id, revision, override_json)
          VALUES (${input.projectId}, ${revision}, ${JSON.stringify(value)})
          ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, override_json = excluded.override_json`;
        return revision;
      }),
    );
  });

const resetProjectOverride = (projectId: string, expectedRevision: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* loadProjectOverride(projectId);
        if ((current?.revision ?? 0) !== expectedRevision) {
          return yield* Effect.fail(
            new ProbeConfigError("revision_conflict", "Project revision changed"),
          );
        }
        yield* sql`DELETE FROM civilization_g9_project_override WHERE project_id = ${projectId}`;
      }),
    );
  });

const setEnvironment = (expectedRevision: number, candidate: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* parseConfig(candidate);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* loadEnvironment;
        if (current.revision !== expectedRevision) {
          return yield* Effect.fail(
            new ProbeConfigError("revision_conflict", "Environment revision changed"),
          );
        }
        const overrides = yield* sql<OverrideRow>`SELECT project_id, revision, override_json
          FROM civilization_g9_project_override ORDER BY project_id`;
        for (const row of overrides) {
          const override = parseOverrideUnsafe(JSON.parse(row.override_json));
          yield* Effect.try({
            try: () => resolveEffective(config, override),
            catch: (cause) =>
              cause instanceof ProbeConfigError
                ? new ProbeConfigError(
                    "dependent_override_invalid",
                    `Project ${row.project_id}: ${cause.message}`,
                  )
                : new ProbeConfigError("invalid_config", String(cause)),
          });
        }
        const revision = current.revision + 1;
        yield* sql`UPDATE civilization_g9_environment
          SET revision = ${revision}, config_json = ${JSON.stringify(config)}
          WHERE environment_id = ${environmentId}`;
        return revision;
      }),
    );
  });

const importEnvironment = (expectedRevision: number, json: string) =>
  Effect.try({
    try: () => JSON.parse(json) as unknown,
    catch: () => new ProbeConfigError("invalid_json", "Import is not valid JSON"),
  }).pipe(Effect.flatMap((value) => setEnvironment(expectedRevision, value)));

const effectiveForProject = (projectId: string) =>
  Effect.gen(function* () {
    const env = yield* loadEnvironment;
    const project = yield* loadProjectOverride(projectId);
    return {
      config: resolveEffective(env.config, project?.override ?? null),
      envRevision: env.revision,
      projectRevision: project?.revision ?? 0,
      provenance: {
        namePool: project?.override.names?.selectedPoolId === undefined ? "environment" : "project",
        profilePool:
          project?.override.personalities?.selectedPoolId === undefined ? "environment" : "project",
      },
    } as const;
  });

const assignCitizen = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly nameDraw: number;
  readonly profileDraw: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const effective = yield* effectiveForProject(input.projectId);
    const namePool = effective.config.names.pools.find(
      (pool) => pool.id === effective.config.names.selectedPoolId,
    )!;
    const profilePool = effective.config.personalities.pools.find(
      (pool) => pool.id === effective.config.personalities.selectedPoolId,
    )!;
    const name = weightedEntry(namePool.entries, input.nameDraw);
    const profile = weightedEntry(profilePool.entries, input.profileDraw);
    yield* sql`INSERT INTO civilization_g9_citizen
      (thread_id, project_id, revision, name_entry_id, profile_entry_id, display_name, profile_label)
      VALUES (${input.threadId}, ${input.projectId}, 1, ${name.id}, ${profile.id}, ${name.displayName}, ${profile.label})`;
    return { name, profile, effective };
  });

const previewReassignment = (input: { readonly projectId: string; readonly limit: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assertIntegerRange(input.limit, 1, 100, "preview.limit");
    const effective = yield* effectiveForProject(input.projectId);
    const namePool = effective.config.names.pools.find(
      (pool) => pool.id === effective.config.names.selectedPoolId,
    )!;
    const profilePool = effective.config.personalities.pools.find(
      (pool) => pool.id === effective.config.personalities.selectedPoolId,
    )!;
    const rows = yield* sql<CitizenRow>`SELECT * FROM civilization_g9_citizen
      WHERE project_id = ${input.projectId} ORDER BY thread_id LIMIT ${input.limit}`;
    return rows.map((row, index) => ({
      threadId: row.thread_id,
      citizenRevision: row.revision,
      expectedEnvRevision: effective.envRevision,
      expectedProjectRevision: effective.projectRevision,
      proposedNameId: weightedEntry(
        namePool.entries,
        index % namePool.entries.reduce((n, e) => n + e.weight, 0),
      ).id,
      proposedProfileId: weightedEntry(
        profilePool.entries,
        index % profilePool.entries.reduce((n, e) => n + e.weight, 0),
      ).id,
    }));
  });

type ReassignmentPreview = {
  readonly threadId: string;
  readonly citizenRevision: number;
  readonly expectedEnvRevision: number;
  readonly expectedProjectRevision: number;
  readonly proposedNameId: string;
  readonly proposedProfileId: string;
};

const applyReassignment = (preview: ReassignmentPreview) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row =
          (yield* sql<CitizenRow>`SELECT * FROM civilization_g9_citizen WHERE thread_id = ${preview.threadId}`)[0];
        if (row === undefined || row.revision !== preview.citizenRevision) {
          return yield* Effect.fail(
            new ProbeConfigError("citizen_conflict", "Citizen revision changed"),
          );
        }
        const effective = yield* effectiveForProject(row.project_id);
        if (
          effective.envRevision !== preview.expectedEnvRevision ||
          effective.projectRevision !== preview.expectedProjectRevision
        ) {
          return yield* Effect.fail(
            new ProbeConfigError("revision_conflict", "Config revision changed"),
          );
        }
        const name = effective.config.names.pools
          .flatMap((pool) => pool.entries)
          .find((entry) => entry.id === preview.proposedNameId);
        const profile = effective.config.personalities.pools
          .flatMap((pool) => pool.entries)
          .find((entry) => entry.id === preview.proposedProfileId);
        if (name === undefined || profile === undefined) {
          return yield* Effect.fail(
            new ProbeConfigError("snapshot_missing", "Preview target disappeared"),
          );
        }
        yield* sql`UPDATE civilization_g9_citizen SET
          revision = ${row.revision + 1},
          name_entry_id = ${name.id}, display_name = ${name.displayName},
          profile_entry_id = ${profile.id}, profile_label = ${profile.label}
          WHERE thread_id = ${row.thread_id}`;
      }),
    );
  });

const expectCode = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect);
    assert.instanceOf(failure, ProbeConfigError);
    if (failure instanceof ProbeConfigError) assert.equal(failure.code, code);
  });

const layerDatabase = SqlitePersistence.layerMemory;

it.effect("validates weighted boundaries and selects canonical half-open ranges", () =>
  Effect.gen(function* () {
    const config = yield* parseConfig(defaultConfig());
    const entries = config.names.pools[0]!.entries;
    const selected = Array.from({ length: 10 }, (_, draw) => weightedEntry(entries, draw).id);
    // Canonical stable-ID order is Ada(6), Grace(3), Linus(1) for these ids.
    assert.deepEqual(selected, [
      "name-ada",
      "name-ada",
      "name-ada",
      "name-ada",
      "name-ada",
      "name-ada",
      "name-grace",
      "name-grace",
      "name-grace",
      "name-linus",
    ]);

    const zeroWeight = mutableClone(config);
    zeroWeight.names.pools[0]!.entries[0]!.weight = 0;
    assert.equal(weightedEntry(zeroWeight.names.pools[0]!.entries, 0).id, "name-grace");

    const allZero = mutableClone(config);
    for (const entry of allZero.personalities.pools[0]!.entries) entry.weight = 0;
    yield* expectCode(parseConfig(allZero), "invalid_pool_reference");

    const renderingOffStillInvalid = mutableClone(allZero);
    renderingOffStillInvalid.personalities.rendering = "off";
    yield* expectCode(parseConfig(renderingOffStillInvalid), "invalid_pool_reference");

    const negative = mutableClone(config);
    negative.names.pools[0]!.entries[0]!.weight = -1;
    yield* expectCode(parseConfig(negative), "invalid_limit");
    const fractional = mutableClone(config);
    fractional.names.pools[0]!.entries[0]!.weight = 0.5;
    yield* expectCode(parseConfig(fractional), "invalid_limit");
    const tooHeavy = mutableClone(config);
    tooHeavy.names.pools[0]!.entries[0]!.weight = MAX_ENTRY_WEIGHT + 1;
    yield* expectCode(parseConfig(tooHeavy), "invalid_limit");

    const duplicateNormalized = mutableClone(config);
    duplicateNormalized.names.pools[0]!.entries.push({
      id: "name-ada-compat",
      displayName: "Ａｄａ",
      weight: 1,
    });
    yield* expectCode(parseConfig(duplicateNormalized), "duplicate_name");

    const unsafeTitle = mutableClone(config);
    unsafeTitle.names.titleTemplate = "[{name}] {topic} {unknown}";
    yield* expectCode(parseConfig(unsafeTitle), "invalid_title_template");
  }).pipe(Effect.provide(Layer.fresh(layerDatabase))),
);

it.effect(
  "resolves env/project inheritance and rejects environment edits that break project references",
  () =>
    Effect.gen(function* () {
      yield* seedEnvironment();
      const projectId = "project:g9:inherit";
      const projectRevision = yield* setProjectOverride({
        projectId,
        expectedRevision: 0,
        value: { version: 1, names: { selectedPoolId: "names-alt" } },
      });
      assert.equal(projectRevision, 1);
      const effective = yield* effectiveForProject(projectId);
      assert.equal(effective.config.names.selectedPoolId, "names-alt");
      assert.equal(effective.config.personalities.selectedPoolId, "profiles-main");
      assert.deepEqual(effective.provenance, { namePool: "project", profilePool: "environment" });

      const current = yield* loadEnvironment;
      const breaking = mutableClone(current.config);
      breaking.names.pools = breaking.names.pools.filter((pool) => pool.id !== "names-alt");
      yield* expectCode(setEnvironment(current.revision, breaking), "dependent_override_invalid");
      assert.equal((yield* loadEnvironment).revision, current.revision);
      assert.equal(
        (yield* effectiveForProject(projectId)).config.names.selectedPoolId,
        "names-alt",
      );

      const valid = mutableClone(current.config);
      valid.context.rosterCount = 11;
      const nextRevision = yield* setEnvironment(current.revision, valid);
      assert.equal(nextRevision, current.revision + 1);
      assert.equal((yield* effectiveForProject(projectId)).config.context.rosterCount, 11);
    }).pipe(Effect.provide(Layer.fresh(layerDatabase))),
);

it.effect("keeps revision/import/reset failures atomic", () =>
  Effect.gen(function* () {
    yield* seedEnvironment();
    const projectId = "project:g9:import";
    yield* setProjectOverride({
      projectId,
      expectedRevision: 0,
      value: { version: 1, messaging: { messageBytes: 2_048 } },
    });

    const before = yield* loadEnvironment;
    const validImport = mutableClone(before.config);
    validImport.participation.enabled = true;
    const importedRevision = yield* importEnvironment(before.revision, JSON.stringify(validImport));
    assert.equal(importedRevision, before.revision + 1);
    assert.isTrue((yield* loadEnvironment).config.participation.enabled);

    yield* expectCode(
      setEnvironment(before.revision, { ...(yield* loadEnvironment).config }),
      "revision_conflict",
    );

    const afterValid = yield* loadEnvironment;
    const unknownVersion = { ...mutableClone(afterValid.config), version: 2 };
    yield* expectCode(
      importEnvironment(afterValid.revision, JSON.stringify(unknownVersion)),
      "invalid_config",
    );
    const unknownField = { ...mutableClone(afterValid.config), surprise: true };
    yield* expectCode(
      importEnvironment(afterValid.revision, JSON.stringify(unknownField)),
      "unknown_field",
    );
    yield* expectCode(importEnvironment(afterValid.revision, "{broken"), "invalid_json");
    assert.equal((yield* loadEnvironment).revision, afterValid.revision);

    const overrideBeforeReset = yield* loadProjectOverride(projectId);
    assert.equal(overrideBeforeReset?.revision, 1);
    yield* expectCode(resetProjectOverride(projectId, 0), "revision_conflict");
    assert.isNotNull(yield* loadProjectOverride(projectId));
    yield* resetProjectOverride(projectId, 1);
    assert.isNull(yield* loadProjectOverride(projectId));
    assert.equal((yield* effectiveForProject(projectId)).config.messaging.messageBytes, 4 * 1024);
  }).pipe(Effect.provide(Layer.fresh(layerDatabase))),
);

it.effect("keeps assignment snapshots stable and guards bounded reassignment preview/apply", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedEnvironment();
    const projectId = "project:g9:snapshot";
    const threadId = "thread:g9:snapshot";
    const assigned = yield* assignCitizen({ threadId, projectId, nameDraw: 0, profileDraw: 0 });
    assert.equal(assigned.name.id, "name-ada");
    assert.equal(assigned.profile.id, "profile-calm");
    assert.equal(assigned.effective.config.personalities.rendering, "off");

    const env = yield* loadEnvironment;
    const changed = mutableClone(env.config);
    changed.names.selectedPoolId = "names-alt";
    changed.names.pools = changed.names.pools.filter((pool) => pool.id !== "names-main");
    changed.personalities.selectedPoolId = "profiles-alt";
    changed.personalities.pools[0]!.entries[0]!.weight = 0;
    yield* setEnvironment(env.revision, changed);
    const snapshot =
      (yield* sql<CitizenRow>`SELECT * FROM civilization_g9_citizen WHERE thread_id = ${threadId}`)[0]!;
    assert.deepEqual(
      {
        name: snapshot.name_entry_id,
        profile: snapshot.profile_entry_id,
        revision: snapshot.revision,
      },
      { name: "name-ada", profile: "profile-calm", revision: 1 },
    );

    const preview = yield* previewReassignment({ projectId, limit: 1 });
    assert.lengthOf(preview, 1);
    assert.equal(preview[0]!.proposedNameId, "name-margaret");
    assert.equal(preview[0]!.proposedProfileId, "profile-neutral");

    const afterPreview = yield* loadEnvironment;
    const revisionOnlyChange = mutableClone(afterPreview.config);
    revisionOnlyChange.context.noteCount = 4;
    yield* setEnvironment(afterPreview.revision, revisionOnlyChange);
    yield* expectCode(applyReassignment(preview[0]!), "revision_conflict");

    const freshPreview = (yield* previewReassignment({ projectId, limit: 1 }))[0]!;
    yield* sql`UPDATE civilization_g9_citizen SET revision = revision + 1 WHERE thread_id = ${threadId}`;
    yield* expectCode(applyReassignment(freshPreview), "citizen_conflict");

    const finalPreview = (yield* previewReassignment({ projectId, limit: 1 }))[0]!;
    yield* applyReassignment(finalPreview);
    const updated =
      (yield* sql<CitizenRow>`SELECT * FROM civilization_g9_citizen WHERE thread_id = ${threadId}`)[0]!;
    assert.equal(updated.name_entry_id, "name-margaret");
    assert.equal(updated.profile_entry_id, "profile-neutral");
    assert.equal(updated.revision, finalPreview.citizenRevision + 1);
  }).pipe(Effect.provide(Layer.fresh(layerDatabase))),
);

it.effect("allows non-destructive ceiling reductions and makes over-capacity intake explicit", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedEnvironment();
    const projectId = "project:g9:capacity";
    yield* sql`INSERT INTO civilization_g9_usage (project_id, message_count, body_bytes)
      VALUES (${projectId}, 120, ${40 * 1024 * 1024})`;

    const before = yield* loadEnvironment;
    const lower = mutableClone(before.config);
    lower.messaging.retainedMessageCount = 100;
    lower.messaging.retainedBodyBytes = 16 * 1024 * 1024;
    const revision = yield* setEnvironment(before.revision, lower);
    assert.equal(revision, before.revision + 1);

    const usage = (yield* sql<{ readonly message_count: number; readonly body_bytes: number }>`
        SELECT message_count, body_bytes FROM civilization_g9_usage WHERE project_id = ${projectId}`)[0]!;
    assert.deepEqual(usage, { message_count: 120, body_bytes: 40 * 1024 * 1024 });

    const effective = (yield* effectiveForProject(projectId)).config;
    const canAccept =
      usage.message_count + 1 <= effective.messaging.retainedMessageCount &&
      usage.body_bytes + 1_024 <= effective.messaging.retainedBodyBytes;
    assert.isFalse(canAccept);
    assert.equal(effective.messaging.retainedMessageCount, 100);
    assert.equal(effective.messaging.retainedBodyBytes, 16 * 1024 * 1024);
  }).pipe(Effect.provide(Layer.fresh(layerDatabase))),
);
