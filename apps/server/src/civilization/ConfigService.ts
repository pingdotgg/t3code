// @effect-diagnostics preferSchemaOverJson:off
import {
  CIVILIZATION_CONFIG_VERSION,
  CIVILIZATION_MAX_ENTRY_WEIGHT,
  CIVILIZATION_MAX_IMPORT_BYTES,
  CIVILIZATION_MAX_MESSAGE_BYTES,
  CIVILIZATION_MAX_NAME_ENTRIES,
  CIVILIZATION_MAX_NOTE_BYTES,
  CIVILIZATION_MAX_PACKET_BYTES,
  CIVILIZATION_MAX_POOLS_PER_KIND,
  CIVILIZATION_MAX_PROFILE_ENTRIES,
  CIVILIZATION_MAX_RETAINED_BODY_BYTES,
  type CivilizationConfig,
  CivilizationConfigConflictError,
  CivilizationConfigInvalidError,
  type CivilizationConfigOverride,
  CivilizationConfigOverride as CivilizationConfigOverrideSchema,
  CivilizationDefaultConfig,
  type CivilizationEffectiveConfig,
  type CivilizationStatus,
  type CivilizationWeightedNameEntry,
  type CivilizationWeightedProfileEntry,
  CivilizationUnavailableError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

export type CivilizationConfigServiceError =
  | CivilizationConfigInvalidError
  | CivilizationConfigConflictError
  | CivilizationUnavailableError
  | SqlError.SqlError;

type EnvironmentRow = { readonly revision: number; readonly override_json: string | null };
type ProjectRow = {
  readonly project_id: string;
  readonly revision: number;
  readonly override_json: string | null;
};
type EffectiveConfigRows = {
  readonly environment_revision: number;
  readonly environment_override_json: string | null;
  readonly project_revision: number;
  readonly project_override_json: string | null;
};

const decodeOverride = Schema.decodeUnknownEffect(CivilizationConfigOverrideSchema, {
  onExcessProperty: "error",
});
const isConfigInvalid = Schema.is(CivilizationConfigInvalidError);

const invalid = (reason: CivilizationConfigInvalidError["reason"], message: string) =>
  new CivilizationConfigInvalidError({
    code: "civilization_invalid_config",
    reason,
    message,
  });

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
export const normalizeCivilizationName = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("en-US");
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const hasUnsafeDisplayFormatting = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

export const isValidCivilizationDisplayName = (value: string) =>
  value.trim().length > 0 && byteLength(value) <= 128 && !hasUnsafeDisplayFormatting(value);

const hasUnsafeTextFormatting = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

function assertIdentifier(value: string, path: string) {
  if (!identifierPattern.test(value)) {
    throw invalid("invalid_config", `${path} is not a valid stable id.`);
  }
}

function assertIntegerRange(value: number, min: number, max: number, path: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid("invalid_limit", `${path} must be an integer in [${min}, ${max}].`);
  }
}

function assertUniqueStrings(values: ReadonlyArray<string>, path: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw invalid("duplicate_id", `${path} contains duplicate value '${value}'.`);
    }
    seen.add(value);
  }
}

function validateTitleTemplate(template: string) {
  if (byteLength(template) > 512 || hasUnsafeDisplayFormatting(template)) {
    throw invalid(
      "invalid_title_template",
      "The managed title template is too large or contains unsafe formatting.",
    );
  }
  const placeholders = [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  if (placeholders.some((placeholder) => !["name", "topic", "generation"].includes(placeholder))) {
    throw invalid(
      "invalid_title_template",
      "Only {name}, {topic}, and {generation} are supported title placeholders.",
    );
  }
  if (placeholders.filter((placeholder) => placeholder === "name").length !== 1) {
    throw invalid("invalid_title_template", "Managed title templates require {name} exactly once.");
  }
  const fixedMaximum = template
    .replaceAll("{name}", "n".repeat(128))
    .replaceAll("{topic}", "")
    .replaceAll("{generation}", String(256));
  if (byteLength(fixedMaximum) > 512) {
    throw invalid(
      "invalid_title_template",
      "The managed title template leaves insufficient room for the maximum citizen identity within 512 bytes.",
    );
  }
}

function validateNamePools(config: CivilizationConfig) {
  if (
    config.names.pools.length === 0 ||
    config.names.pools.length > CIVILIZATION_MAX_POOLS_PER_KIND
  ) {
    throw invalid(
      "invalid_limit",
      `Name pool count must be between 1 and ${CIVILIZATION_MAX_POOLS_PER_KIND}.`,
    );
  }
  const poolIds = new Set<string>();
  const entryIds = new Set<string>();
  const normalizedNames = new Set<string>();
  const totals = new Map<string, number>();
  for (const pool of config.names.pools) {
    assertIdentifier(pool.id, `names.pools.${pool.id}`);
    if (poolIds.has(pool.id)) throw invalid("duplicate_id", `Duplicate name pool id '${pool.id}'.`);
    poolIds.add(pool.id);
    if (pool.entries.length > CIVILIZATION_MAX_NAME_ENTRIES) {
      throw invalid(
        "invalid_limit",
        `Name pool '${pool.id}' exceeds ${CIVILIZATION_MAX_NAME_ENTRIES} entries.`,
      );
    }
    let total = 0;
    for (const entry of pool.entries) {
      assertIdentifier(entry.id, `names.${pool.id}.${entry.id}`);
      if (entryIds.has(entry.id))
        throw invalid("duplicate_id", `Duplicate name entry id '${entry.id}'.`);
      entryIds.add(entry.id);
      assertIntegerRange(
        entry.weight,
        0,
        CIVILIZATION_MAX_ENTRY_WEIGHT,
        `names.${pool.id}.${entry.id}.weight`,
      );
      if (!isValidCivilizationDisplayName(entry.displayName)) {
        throw invalid(
          "invalid_name",
          `Name '${entry.id}' is empty, too large, or contains unsafe formatting.`,
        );
      }
      const key = normalizeCivilizationName(entry.displayName);
      if (normalizedNames.has(key)) {
        throw invalid("duplicate_name", `Duplicate normalized name '${entry.displayName}'.`);
      }
      normalizedNames.add(key);
      total += entry.weight;
      if (!Number.isSafeInteger(total)) {
        throw invalid("unsafe_weight_total", `Name pool '${pool.id}' has an unsafe total weight.`);
      }
    }
    totals.set(pool.id, total);
  }
  if ((totals.get(config.names.selectedPoolId) ?? 0) <= 0) {
    throw invalid(
      "invalid_pool_reference",
      "The selected name pool must exist and have positive total weight.",
    );
  }
  validateTitleTemplate(config.names.titleTemplate);
}

function validateProfilePools(config: CivilizationConfig) {
  if (
    config.personalities.pools.length === 0 ||
    config.personalities.pools.length > CIVILIZATION_MAX_POOLS_PER_KIND
  ) {
    throw invalid(
      "invalid_limit",
      `Profile pool count must be between 1 and ${CIVILIZATION_MAX_POOLS_PER_KIND}.`,
    );
  }
  const poolIds = new Set<string>();
  const entryIds = new Set<string>();
  const totals = new Map<string, number>();
  for (const pool of config.personalities.pools) {
    assertIdentifier(pool.id, `personalities.pools.${pool.id}`);
    if (poolIds.has(pool.id))
      throw invalid("duplicate_id", `Duplicate profile pool id '${pool.id}'.`);
    poolIds.add(pool.id);
    if (pool.entries.length > CIVILIZATION_MAX_PROFILE_ENTRIES) {
      throw invalid(
        "invalid_limit",
        `Profile pool '${pool.id}' exceeds ${CIVILIZATION_MAX_PROFILE_ENTRIES} entries.`,
      );
    }
    let total = 0;
    for (const entry of pool.entries) {
      assertIdentifier(entry.id, `personalities.${pool.id}.${entry.id}`);
      if (entryIds.has(entry.id)) {
        throw invalid("duplicate_id", `Duplicate profile entry id '${entry.id}'.`);
      }
      entryIds.add(entry.id);
      assertIntegerRange(
        entry.weight,
        0,
        CIVILIZATION_MAX_ENTRY_WEIGHT,
        `personalities.${pool.id}.${entry.id}.weight`,
      );
      if (
        entry.label.trim().length === 0 ||
        byteLength(entry.label) > 128 ||
        hasUnsafeDisplayFormatting(entry.label) ||
        byteLength(entry.styleText) > 512 ||
        hasUnsafeTextFormatting(entry.styleText) ||
        entry.rich.label.trim().length === 0 ||
        byteLength(entry.rich.label) > 128 ||
        hasUnsafeDisplayFormatting(entry.rich.label) ||
        entry.rich.axiom.trim().length === 0 ||
        byteLength(entry.rich.axiom) > 256 ||
        hasUnsafeTextFormatting(entry.rich.axiom) ||
        entry.rich.voice.trim().length === 0 ||
        byteLength(entry.rich.voice) > 256 ||
        hasUnsafeTextFormatting(entry.rich.voice) ||
        byteLength(entry.rich.styleText) > 512 ||
        hasUnsafeTextFormatting(entry.rich.styleText)
      ) {
        throw invalid(
          "invalid_profile",
          `Profile '${entry.id}' has an invalid label or style text.`,
        );
      }
      if (entry.traits.length > 16) {
        throw invalid("invalid_profile", `Profile '${entry.id}' has too many traits.`);
      }
      if (entry.rich.traits.length > 16) {
        throw invalid("invalid_profile", `Profile '${entry.id}' has too many rich traits.`);
      }
      for (const trait of [...entry.traits, ...entry.rich.traits]) {
        if (
          trait.trim().length === 0 ||
          byteLength(trait) > 128 ||
          hasUnsafeDisplayFormatting(trait)
        ) {
          throw invalid("invalid_profile", `Profile '${entry.id}' has an invalid trait.`);
        }
      }
      total += entry.weight;
      if (!Number.isSafeInteger(total)) {
        throw invalid(
          "unsafe_weight_total",
          `Profile pool '${pool.id}' has an unsafe total weight.`,
        );
      }
    }
    totals.set(pool.id, total);
  }
  if ((totals.get(config.personalities.selectedPoolId) ?? 0) <= 0) {
    throw invalid(
      "invalid_pool_reference",
      "The selected profile pool must exist and have positive total weight.",
    );
  }
}

function validateCivilizationRuntimeFieldsUnsafe(config: CivilizationConfig) {
  if (config.knowledge.noteCategories.length > 64) {
    throw invalid("invalid_limit", "knowledge.noteCategories exceeds 64 entries.");
  }
  for (const category of config.knowledge.noteCategories) {
    assertIdentifier(category, "knowledge.noteCategories");
  }
  assertUniqueStrings(config.knowledge.noteCategories, "knowledge.noteCategories");
  assertIntegerRange(
    config.knowledge.noteBytes,
    0,
    CIVILIZATION_MAX_NOTE_BYTES,
    "knowledge.noteBytes",
  );
  assertIntegerRange(config.knowledge.activeNotes, 0, 2_000, "knowledge.activeNotes");
  assertIntegerRange(config.knowledge.retentionDays, 0, 365, "knowledge.retentionDays");
  assertIntegerRange(
    config.context.packetBytes,
    0,
    CIVILIZATION_MAX_PACKET_BYTES,
    "context.packetBytes",
  );
  assertIntegerRange(config.context.rosterCount, 0, 50, "context.rosterCount");
  assertIntegerRange(config.context.noteCount, 0, 10, "context.noteCount");
  assertIntegerRange(config.context.inboxExcerptCount, 0, 20, "context.inboxExcerptCount");
  assertIntegerRange(
    config.messaging.messageBytes,
    0,
    CIVILIZATION_MAX_MESSAGE_BYTES,
    "messaging.messageBytes",
  );
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
    CIVILIZATION_MAX_RETAINED_BODY_BYTES,
    "messaging.retainedBodyBytes",
  );
  assertIntegerRange(config.messaging.unreadTtlDays, 0, 365, "messaging.unreadTtlDays");
  assertUniqueStrings(config.messaging.eligibleThreadKinds, "messaging.eligibleThreadKinds");
  if (config.messaging.enabled && config.messaging.eligibleThreadKinds.length === 0) {
    throw invalid("invalid_config", "Messaging cannot be enabled with no eligible thread kinds.");
  }
  assertIntegerRange(
    config.operations.terminalRetentionDays,
    0,
    365,
    "operations.terminalRetentionDays",
  );
  assertIntegerRange(
    config.operations.operationReceiptRetentionDays,
    30,
    365,
    "operations.operationReceiptRetentionDays",
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
  assertIntegerRange(config.operations.censusPageSize, 1, 100, "operations.censusPageSize");
  assertIntegerRange(config.operations.inboxPageSize, 1, 100, "operations.inboxPageSize");
  assertIntegerRange(
    config.operations.responseBodyBytes,
    1,
    64 * 1024,
    "operations.responseBodyBytes",
  );
}

export function validateCivilizationConfigUnsafe(config: CivilizationConfig): CivilizationConfig {
  validateNamePools(config);
  validateProfilePools(config);
  validateCivilizationRuntimeFieldsUnsafe(config);
  if (byteLength(JSON.stringify(config)) > CIVILIZATION_MAX_IMPORT_BYTES) {
    throw invalid(
      "import_too_large",
      `Effective configuration exceeds ${CIVILIZATION_MAX_IMPORT_BYTES} UTF-8 bytes.`,
    );
  }
  return config;
}

const overrideChangesNameStructure = (override: CivilizationConfigOverride | null) =>
  override?.names?.pools !== undefined ||
  override?.names?.selectedPoolId !== undefined ||
  override?.names?.titleTemplate !== undefined;

const overrideChangesProfileStructure = (override: CivilizationConfigOverride | null) =>
  override?.personalities?.pools !== undefined ||
  override?.personalities?.selectedPoolId !== undefined;

function resolvePersistedCivilizationConfigUnsafe(
  environmentOverride: CivilizationConfigOverride | null,
  projectOverride: CivilizationConfigOverride | null,
): CivilizationConfig {
  const environment = applyCivilizationOverride(CivilizationDefaultConfig, environmentOverride);
  const config = applyCivilizationOverride(environment, projectOverride);

  // Persisted overrides are schema-decoded on every read and were fully
  // validated at commit/migration time. Re-walking the large built-in pools
  // and serializing the entire merged config on every provider turn made the
  // hot packet path scale with personality copy that the override did not
  // change. Revalidate pool invariants only when a stored override can affect
  // them; always re-check the inexpensive runtime limits so logical corruption
  // in mutable scalar fields still fails closed.
  if (
    overrideChangesNameStructure(environmentOverride) ||
    overrideChangesNameStructure(projectOverride)
  ) {
    validateNamePools(config);
  }
  if (
    overrideChangesProfileStructure(environmentOverride) ||
    overrideChangesProfileStructure(projectOverride)
  ) {
    validateProfilePools(config);
  }
  validateCivilizationRuntimeFieldsUnsafe(config);
  return config;
}

function mergeSection<T extends object>(base: T, override: object | undefined): T {
  if (override === undefined) return base;
  const definedEntries = Object.entries(override).filter(([, value]) => value !== undefined);
  return { ...base, ...Object.fromEntries(definedEntries) } as T;
}

export function applyCivilizationOverride(
  base: CivilizationConfig,
  override: CivilizationConfigOverride | null,
): CivilizationConfig {
  if (override === null) return base;
  return {
    version: CIVILIZATION_CONFIG_VERSION,
    participation: mergeSection(base.participation, override.participation),
    names: mergeSection(base.names, override.names),
    personalities: mergeSection(base.personalities, override.personalities),
    knowledge: mergeSection(base.knowledge, override.knowledge),
    context: mergeSection(base.context, override.context),
    messaging: mergeSection(base.messaging, override.messaging),
    operations: mergeSection(base.operations, override.operations),
  };
}

export function resolveCivilizationConfigUnsafe(
  environmentOverride: CivilizationConfigOverride | null,
  projectOverride: CivilizationConfigOverride | null,
): CivilizationConfig {
  const environment = applyCivilizationOverride(
    structuredClone(CivilizationDefaultConfig),
    environmentOverride,
  );
  return validateCivilizationConfigUnsafe(applyCivilizationOverride(environment, projectOverride));
}

const parseOverride = (input: unknown) =>
  decodeOverride(input).pipe(
    Effect.mapError(() =>
      invalid(
        "invalid_config",
        `Configuration override does not match schema version ${CIVILIZATION_CONFIG_VERSION}.`,
      ),
    ),
    Effect.flatMap((override) =>
      byteLength(JSON.stringify(override)) > CIVILIZATION_MAX_IMPORT_BYTES
        ? Effect.fail(
            invalid(
              "import_too_large",
              `Configuration override exceeds ${CIVILIZATION_MAX_IMPORT_BYTES} UTF-8 bytes.`,
            ),
          )
        : Effect.succeed(override),
    ),
  );

const storedOverrideDecodeCache = new Map<string, CivilizationConfigOverride>();
const rememberStoredOverride = (json: string, override: CivilizationConfigOverride) => {
  // Configuration revisions are rare, but a long-lived server can still see
  // many historical raw strings across projects. Keep this hot-path decode
  // cache strictly bounded; exact raw JSON is the key so direct DB changes are
  // immediately observable and never reuse a stale decoded value.
  if (storedOverrideDecodeCache.size >= 128 && !storedOverrideDecodeCache.has(json)) {
    storedOverrideDecodeCache.clear();
  }
  storedOverrideDecodeCache.set(json, override);
  return override;
};

const parseStoredOverride = (json: string | null) =>
  json === null
    ? Effect.succeed<CivilizationConfigOverride | null>(null)
    : storedOverrideDecodeCache.has(json)
      ? Effect.succeed(storedOverrideDecodeCache.get(json)!)
      : Effect.try({
          try: () => JSON.parse(json) as unknown,
          catch: () =>
            new CivilizationUnavailableError({
              code: "civilization_unavailable",
              reason: "corrupt_state",
              message: "Stored Civilization configuration is not valid JSON.",
            }),
        }).pipe(
          Effect.flatMap((value) =>
            parseOverride(value).pipe(
              Effect.map(rememberStoredOverride.bind(null, json)),
              Effect.mapError(
                () =>
                  new CivilizationUnavailableError({
                    code: "civilization_unavailable",
                    reason: "corrupt_state",
                    message: `Stored Civilization configuration does not match schema version ${CIVILIZATION_CONFIG_VERSION}.`,
                  }),
              ),
            ),
          ),
        );

const validateConfig = (config: CivilizationConfig) =>
  Effect.try({
    try: () => validateCivilizationConfigUnsafe(config),
    catch: (cause) =>
      isConfigInvalid(cause)
        ? cause
        : invalid("invalid_config", "Civilization configuration validation failed."),
  });

export const readCivilizationEnvironmentConfig = Effect.fn("CivilizationConfig.readEnvironment")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql<EnvironmentRow>`
      SELECT revision, override_json
      FROM civilization_environment_config
      WHERE singleton = 1
      LIMIT 1
    `)[0];
    if (row === undefined) return { revision: 0, override: null } as const;
    return {
      revision: row.revision,
      override: yield* parseStoredOverride(row.override_json),
    } as const;
  },
);

export const readCivilizationProjectConfig = Effect.fn("CivilizationConfig.readProject")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = (yield* sql<ProjectRow>`
        SELECT project_id, revision, override_json
        FROM civilization_project_config
        WHERE project_id = ${projectId}
        LIMIT 1
      `)[0];
  if (row === undefined) return { revision: 0, override: null } as const;
  return {
    revision: row.revision,
    override: yield* parseStoredOverride(row.override_json),
  } as const;
});

const ensureProjectExists = Effect.fn("CivilizationConfig.ensureProjectExists")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly project_id: string }>`
    SELECT project_id FROM projection_projects
    WHERE project_id = ${projectId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) {
    return yield* Effect.fail(invalid("invalid_config", `Project ${projectId} does not exist.`));
  }
});

const configurablePaths = [
  "participation.enabled",
  "participation.emergencyOff",
  "participation.adoption",
  "participation.includeControllableChildren",
  "participation.showObservedAgents",
  "names.pools",
  "names.selectedPoolId",
  "names.titleTemplate",
  "names.automaticTitles",
  "names.adoptionTitlePolicy",
  "personalities.pools",
  "personalities.selectedPoolId",
  "personalities.rendering",
  "knowledge.noteCategories",
  "knowledge.noteBytes",
  "knowledge.activeNotes",
  "knowledge.retentionDays",
  "knowledge.packetInclusion",
  "knowledge.ancestorReads",
  "knowledge.showGeneration",
  "knowledge.showParent",
  "context.packetBytes",
  "context.rosterCount",
  "context.noteCount",
  "context.inboxExcerptCount",
  "context.selection",
  "messaging.enabled",
  "messaging.eligibleThreadKinds",
  "messaging.allowControllableChildren",
  "messaging.messageBytes",
  "messaging.pendingPerRecipient",
  "messaging.senderPerMinute",
  "messaging.projectPerMinute",
  "messaging.retainedMessageCount",
  "messaging.retainedBodyBytes",
  "messaging.unreadTtlDays",
  "messaging.repliesEnabled",
  "operations.terminalRetentionDays",
  "operations.operationReceiptRetentionDays",
  "operations.diagnosticRetentionDays",
  "operations.tombstoneRetentionDays",
  "operations.cleanupCadenceMinutes",
  "operations.cleanupBatch",
  "operations.censusPageSize",
  "operations.inboxPageSize",
  "operations.responseBodyBytes",
  "operations.diagnostics",
] as const;

const hasOverridePath = (override: CivilizationConfigOverride | null, path: string) => {
  if (override === null) return false;
  const [section, field] = path.split(".");
  const sectionValue = (override as Record<string, unknown>)[section!];
  return (
    typeof sectionValue === "object" &&
    sectionValue !== null &&
    Object.prototype.hasOwnProperty.call(sectionValue, field!)
  );
};

const selectedProbabilities = <Entry extends { readonly id: string; readonly weight: number }>(
  entries: ReadonlyArray<Entry>,
) => {
  const ordered = [...entries].toSorted((left, right) => left.id.localeCompare(right.id));
  const totalWeight = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  return ordered.map((entry) => ({
    id: entry.id,
    weight: entry.weight,
    totalWeight,
    probability: totalWeight === 0 ? 0 : entry.weight / totalWeight,
  }));
};

export function weightedCivilizationEntry<
  Entry extends CivilizationWeightedNameEntry | CivilizationWeightedProfileEntry,
>(entries: ReadonlyArray<Entry>, draw: number): Entry {
  const ordered = [...entries].toSorted((left, right) => left.id.localeCompare(right.id));
  const total = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isSafeInteger(draw) || draw < 0 || draw >= total) {
    throw invalid("invalid_config", `Weighted draw ${draw} is outside [0, ${total}).`);
  }
  let cursor = 0;
  for (const entry of ordered) {
    const end = cursor + entry.weight;
    if (draw >= cursor && draw < end) return entry;
    cursor = end;
  }
  throw invalid("invalid_config", "No weighted configuration entry was selected.");
}

function effectiveResultFromConfig(
  input: {
    readonly environmentRevision: number;
    readonly environmentOverride: CivilizationConfigOverride | null;
    readonly projectRevision: number;
    readonly projectOverride: CivilizationConfigOverride | null;
  },
  config: CivilizationConfig,
): CivilizationEffectiveConfig {
  const namePool = config.names.pools.find((pool) => pool.id === config.names.selectedPoolId)!;
  const profilePool = config.personalities.pools.find(
    (pool) => pool.id === config.personalities.selectedPoolId,
  )!;
  return {
    config,
    environmentRevision: input.environmentRevision,
    projectRevision: input.projectRevision,
    provenance: configurablePaths.map((path) => ({
      path,
      source: hasOverridePath(input.projectOverride, path)
        ? "project"
        : hasOverridePath(input.environmentOverride, path)
          ? "environment"
          : "builtin",
    })),
    selectedNameProbabilities: selectedProbabilities(namePool.entries),
    selectedProfileProbabilities: selectedProbabilities(profilePool.entries),
  };
}

function effectiveResult(input: {
  readonly environmentRevision: number;
  readonly environmentOverride: CivilizationConfigOverride | null;
  readonly projectRevision: number;
  readonly projectOverride: CivilizationConfigOverride | null;
}): CivilizationEffectiveConfig {
  const config = resolveCivilizationConfigUnsafe(input.environmentOverride, input.projectOverride);
  return effectiveResultFromConfig(input, config);
}

const readPersistedConfigInput = Effect.fn("CivilizationConfig.readPersistedConfigInput")(
  function* (projectId?: ProjectId) {
    if (projectId === undefined) {
      const environment = yield* readCivilizationEnvironmentConfig();
      return {
        environmentRevision: environment.revision,
        environmentOverride: environment.override,
        projectRevision: 0,
        projectOverride: null,
      } as const;
    }

    const sql = yield* SqlClient.SqlClient;
    const combined = (yield* sql<EffectiveConfigRows>`
        SELECT COALESCE((
                 SELECT revision FROM civilization_environment_config WHERE singleton = 1 LIMIT 1
               ), 0) AS environment_revision,
               (SELECT override_json FROM civilization_environment_config WHERE singleton = 1 LIMIT 1)
                 AS environment_override_json,
               COALESCE((
                 SELECT revision FROM civilization_project_config
                 WHERE project_id = ${projectId} LIMIT 1
               ), 0) AS project_revision,
               (SELECT override_json FROM civilization_project_config
                 WHERE project_id = ${projectId} LIMIT 1) AS project_override_json
      `)[0]!;
    return {
      environmentRevision: combined.environment_revision,
      environmentOverride: yield* parseStoredOverride(combined.environment_override_json),
      projectRevision: combined.project_revision,
      projectOverride: yield* parseStoredOverride(combined.project_override_json),
    } as const;
  },
);

const storedConfigResolutionError = (cause: unknown) =>
  isConfigInvalid(cause)
    ? new CivilizationUnavailableError({
        code: "civilization_unavailable",
        reason: "corrupt_state",
        message: cause.message,
      })
    : new CivilizationUnavailableError({
        code: "civilization_unavailable",
        reason: "corrupt_state",
        message: "Stored Civilization configuration could not be resolved.",
      });

export const getRuntimeCivilizationConfig = Effect.fn("CivilizationConfig.getRuntime")(function* (
  projectId?: ProjectId,
) {
  const input = yield* readPersistedConfigInput(projectId);
  return yield* Effect.try({
    try: () => ({
      config: resolvePersistedCivilizationConfigUnsafe(
        input.environmentOverride,
        input.projectOverride,
      ),
      environmentRevision: input.environmentRevision,
      projectRevision: input.projectRevision,
    }),
    catch: storedConfigResolutionError,
  });
});

export const getEffectiveCivilizationConfig = Effect.fn("CivilizationConfig.getEffective")(
  function* (projectId?: ProjectId) {
    const input = yield* readPersistedConfigInput(projectId);
    return yield* Effect.try({
      try: () => {
        return effectiveResultFromConfig(
          input,
          resolvePersistedCivilizationConfigUnsafe(
            input.environmentOverride,
            input.projectOverride,
          ),
        );
      },
      catch: storedConfigResolutionError,
    });
  },
);

const validateEnvironmentCandidate = Effect.fn("CivilizationConfig.validateEnvironmentCandidate")(
  function* (override: CivilizationConfigOverride) {
    const sql = yield* SqlClient.SqlClient;
    yield* validateConfig(
      applyCivilizationOverride(structuredClone(CivilizationDefaultConfig), override),
    );
    const projects = yield* sql<ProjectRow>`
      SELECT project_id, revision, override_json
      FROM civilization_project_config
      WHERE override_json IS NOT NULL
      ORDER BY project_id ASC
    `;
    for (const project of projects) {
      const projectOverride = yield* parseStoredOverride(project.override_json);
      yield* Effect.try({
        try: () => resolveCivilizationConfigUnsafe(override, projectOverride),
        catch: (cause) =>
          isConfigInvalid(cause)
            ? invalid(
                "dependent_override_invalid",
                `Project ${project.project_id} becomes invalid: ${cause.message}`,
              )
            : invalid("invalid_config", `Project ${project.project_id} could not be validated.`),
      });
    }
  },
);

const validateCandidate = Effect.fn("CivilizationConfig.validateCandidate")(function* (input: {
  readonly projectId?: ProjectId | undefined;
  readonly override: CivilizationConfigOverride;
}) {
  const override = yield* parseOverride(input.override);
  if (input.projectId === undefined) {
    yield* validateEnvironmentCandidate(override);
    const environment = yield* readCivilizationEnvironmentConfig();
    return yield* validateConfig(
      applyCivilizationOverride(structuredClone(CivilizationDefaultConfig), override),
    ).pipe(
      Effect.map(() =>
        effectiveResult({
          environmentRevision: environment.revision,
          environmentOverride: override,
          projectRevision: 0,
          projectOverride: null,
        }),
      ),
    );
  }
  yield* ensureProjectExists(input.projectId);
  const environment = yield* readCivilizationEnvironmentConfig();
  yield* validateConfig(resolveCivilizationConfigUnsafe(environment.override, override));
  const project = yield* readCivilizationProjectConfig(input.projectId);
  return effectiveResult({
    environmentRevision: environment.revision,
    environmentOverride: environment.override,
    projectRevision: project.revision,
    projectOverride: override,
  });
});

const setOverride = Effect.fn("CivilizationConfig.setOverride")(function* (input: {
  readonly projectId?: ProjectId | undefined;
  readonly expectedRevision: number;
  readonly override: CivilizationConfigOverride;
}) {
  const sql = yield* SqlClient.SqlClient;
  const override = yield* parseOverride(input.override);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (input.projectId === undefined) {
        const current = yield* readCivilizationEnvironmentConfig();
        if (current.revision !== input.expectedRevision) {
          return yield* Effect.fail(
            new CivilizationConfigConflictError({
              code: "civilization_conflict",
              scope: "environment",
              expectedRevision: input.expectedRevision,
              currentRevision: current.revision,
            }),
          );
        }
        yield* validateEnvironmentCandidate(override);
        const revision = current.revision + 1;
        yield* sql`
          UPDATE civilization_environment_config
          SET revision = ${revision}, override_json = ${JSON.stringify(override)}, updated_at = datetime('now')
          WHERE singleton = 1
        `;
        return { revision, effective: yield* getEffectiveCivilizationConfig() };
      }

      yield* ensureProjectExists(input.projectId);
      const current = yield* readCivilizationProjectConfig(input.projectId);
      if (current.revision !== input.expectedRevision) {
        return yield* Effect.fail(
          new CivilizationConfigConflictError({
            code: "civilization_conflict",
            scope: "project",
            expectedRevision: input.expectedRevision,
            currentRevision: current.revision,
          }),
        );
      }
      const environment = yield* readCivilizationEnvironmentConfig();
      yield* validateConfig(resolveCivilizationConfigUnsafe(environment.override, override));
      const revision = current.revision + 1;
      yield* sql`
        INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
        VALUES (${input.projectId}, ${revision}, ${JSON.stringify(override)}, datetime('now'))
        ON CONFLICT(project_id) DO UPDATE SET
          revision = excluded.revision,
          override_json = excluded.override_json,
          updated_at = excluded.updated_at
      `;
      return { revision, effective: yield* getEffectiveCivilizationConfig(input.projectId) };
    }),
  );
});

const resetOverride = Effect.fn("CivilizationConfig.resetOverride")(function* (input: {
  readonly projectId?: ProjectId | undefined;
  readonly expectedRevision: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (input.projectId === undefined) {
        const currentRevision =
          (yield* sql<{ readonly revision: number }>`
            SELECT revision
            FROM civilization_environment_config
            WHERE singleton = 1
            LIMIT 1
          `)[0]?.revision ?? 0;
        if (currentRevision !== input.expectedRevision) {
          return yield* Effect.fail(
            new CivilizationConfigConflictError({
              code: "civilization_conflict",
              scope: "environment",
              expectedRevision: input.expectedRevision,
              currentRevision,
            }),
          );
        }
        const empty: CivilizationConfigOverride = { version: CIVILIZATION_CONFIG_VERSION };
        yield* validateEnvironmentCandidate(empty);
        const revision = currentRevision + 1;
        yield* sql`
          UPDATE civilization_environment_config
          SET revision = ${revision}, override_json = NULL, updated_at = datetime('now')
          WHERE singleton = 1
        `;
        return { revision, effective: yield* getEffectiveCivilizationConfig() };
      }

      yield* ensureProjectExists(input.projectId);
      const currentRevision =
        (yield* sql<{ readonly revision: number }>`
          SELECT revision
          FROM civilization_project_config
          WHERE project_id = ${input.projectId}
          LIMIT 1
        `)[0]?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        return yield* Effect.fail(
          new CivilizationConfigConflictError({
            code: "civilization_conflict",
            scope: "project",
            expectedRevision: input.expectedRevision,
            currentRevision,
          }),
        );
      }
      const revision = currentRevision + 1;
      yield* sql`
        INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
        VALUES (${input.projectId}, ${revision}, NULL, datetime('now'))
        ON CONFLICT(project_id) DO UPDATE SET
          revision = excluded.revision,
          override_json = NULL,
          updated_at = excluded.updated_at
      `;
      return { revision, effective: yield* getEffectiveCivilizationConfig(input.projectId) };
    }),
  );
});

const importOverride = Effect.fn("CivilizationConfig.importOverride")(function* (input: {
  readonly projectId?: ProjectId | undefined;
  readonly expectedRevision: number;
  readonly json: string;
}) {
  if (byteLength(input.json) > CIVILIZATION_MAX_IMPORT_BYTES) {
    return yield* Effect.fail(
      invalid(
        "import_too_large",
        `Configuration import exceeds ${CIVILIZATION_MAX_IMPORT_BYTES} UTF-8 bytes.`,
      ),
    );
  }
  const value = yield* Effect.try({
    try: () => JSON.parse(input.json) as unknown,
    catch: () => invalid("invalid_json", "Configuration import is not valid JSON."),
  });
  const override = yield* parseOverride(value);
  return yield* setOverride({ ...input, override });
});

const exportOverride = Effect.fn("CivilizationConfig.exportOverride")(function* (
  projectId?: ProjectId,
) {
  const record =
    projectId === undefined
      ? yield* readCivilizationEnvironmentConfig()
      : yield* readCivilizationProjectConfig(projectId);
  return {
    json: JSON.stringify(record.override ?? { version: CIVILIZATION_CONFIG_VERSION }, null, 2),
    effective: yield* getEffectiveCivilizationConfig(projectId),
  };
});

function diffValues(
  before: unknown,
  after: unknown,
  prefix = "",
): ReadonlyArray<{ readonly path: string; readonly before: unknown; readonly after: unknown }> {
  if (Object.is(before, after)) return [];
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [{ path: prefix || "$", before, after }];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .toSorted()
    .flatMap((key) =>
      diffValues(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        prefix.length === 0 ? key : `${prefix}.${key}`,
      ),
    );
}

const diff = Effect.fn("CivilizationConfig.diff")(function* (input: {
  readonly projectId?: ProjectId | undefined;
  readonly override: CivilizationConfigOverride;
}) {
  const before = yield* getEffectiveCivilizationConfig(input.projectId);
  const effective = yield* validateCandidate(input);
  return { changes: diffValues(before.config, effective.config), effective };
});

const description = {
  version: CIVILIZATION_CONFIG_VERSION,
  inheritance:
    "built-in defaults -> environment override -> project override; absent fields inherit; pool arrays replace as a whole",
  applicationTiming: {
    participation:
      "committed configuration applies immediately to new enrollment and eligibility; emergency off dominates",
    identities: "name/profile snapshots are assigned once at enrollment; reassignment is explicit",
    personalities:
      "rendering changes on the next supported provider input without rerolling the stored profile",
    messaging:
      "limits and enablement apply to future intake/offer checks; accepted message TTL is snapshotted",
    retention:
      "lower limits never delete data silently; cleanup uses explicit eligibility and bounded batches",
  },
  limits: {
    nameEntriesPerPool: CIVILIZATION_MAX_NAME_ENTRIES,
    profileEntriesPerPool: CIVILIZATION_MAX_PROFILE_ENTRIES,
    poolsPerKind: CIVILIZATION_MAX_POOLS_PER_KIND,
    importBytes: CIVILIZATION_MAX_IMPORT_BYTES,
    entryWeight: CIVILIZATION_MAX_ENTRY_WEIGHT,
    profileLabelBytes: 128,
    profileTraits: 16,
    profileStyleTextBytes: 512,
    profileRichLabelBytes: 128,
    profileRichTraits: 16,
    profileRichAxiomBytes: 256,
    profileRichVoiceBytes: 256,
    profileRichStyleTextBytes: 512,
    packetBytes: CIVILIZATION_MAX_PACKET_BYTES,
    messageBytes: CIVILIZATION_MAX_MESSAGE_BYTES,
    noteBytes: CIVILIZATION_MAX_NOTE_BYTES,
    retainedBodyBytes: CIVILIZATION_MAX_RETAINED_BODY_BYTES,
  },
} as const;

const status = Effect.fn("CivilizationConfig.status")(function* (projectId?: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* getEffectiveCivilizationConfig(projectId);
  const counts =
    projectId === undefined
      ? (yield* sql<{ readonly citizens: number; readonly open_citizens: number }>`
            SELECT COUNT(*) AS citizens,
                   SUM(CASE WHEN closed = 0 AND deleted = 0 THEN 1 ELSE 0 END) AS open_citizens
            FROM civilization_citizens
          `)[0]
      : (yield* sql<{ readonly citizens: number; readonly open_citizens: number }>`
            SELECT COUNT(*) AS citizens,
                   SUM(CASE WHEN closed = 0 AND deleted = 0 THEN 1 ELSE 0 END) AS open_citizens
            FROM civilization_citizens
            WHERE project_id = ${projectId}
          `)[0];
  const featureEnabled =
    effective.config.participation.enabled && !effective.config.participation.emergencyOff;
  const unadoptedCount =
    featureEnabled && effective.config.participation.adoption === "all_existing"
      ? ((projectId === undefined
          ? yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM orchestration_v2_projection_threads t
                LEFT JOIN civilization_citizens c ON c.thread_id = t.thread_id
                WHERE t.deleted_at IS NULL AND c.thread_id IS NULL
              `
          : yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM orchestration_v2_projection_threads t
                LEFT JOIN civilization_citizens c ON c.thread_id = t.thread_id
                WHERE t.deleted_at IS NULL AND c.thread_id IS NULL AND t.project_id = ${projectId}
              `)[0]?.count ?? 0)
      : 0;
  return {
    status: featureEnabled ? (unadoptedCount > 0 ? "adopting" : "active") : "disabled",
    environmentRevision: effective.environmentRevision,
    projectRevision: effective.projectRevision,
    citizenCount: counts?.citizens ?? 0,
    openCitizenCount: counts?.open_citizens ?? 0,
    ...(unadoptedCount > 0
      ? { detail: `${unadoptedCount} existing threads remain to adopt.` }
      : {}),
  } satisfies CivilizationStatus;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provideSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const runtimeCache = new Map<
    string,
    Effect.Success<ReturnType<typeof getRuntimeCivilizationConfig>>
  >();
  let runtimeCacheGeneration = 0;
  const runtimeKey = (projectId?: ProjectId) =>
    projectId === undefined ? "<environment>" : String(projectId);
  const getRuntime = (projectId?: ProjectId) => {
    const key = runtimeKey(projectId);
    const cached = runtimeCache.get(key);
    if (cached !== undefined) return Effect.succeed(cached);
    return Effect.suspend(() => {
      const generation = runtimeCacheGeneration;
      return provideSql(getRuntimeCivilizationConfig(projectId)).pipe(
        Effect.tap((resolved) =>
          Effect.sync(() => {
            if (generation === runtimeCacheGeneration) runtimeCache.set(key, resolved);
          }),
        ),
      );
    });
  };
  const invalidateRuntimeCache = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.sync(() => {
      runtimeCacheGeneration += 1;
    }).pipe(
      Effect.andThen(provideSql(effect)),
      Effect.ensuring(
        Effect.sync(() => {
          runtimeCacheGeneration += 1;
          runtimeCache.clear();
        }),
      ),
    );
  return {
    describe: Effect.succeed(description),
    getEffective: (projectId?: ProjectId) => provideSql(getEffectiveCivilizationConfig(projectId)),
    getRuntime,
    validate: (input: Parameters<typeof validateCandidate>[0]) =>
      provideSql(validateCandidate(input)),
    diff: (input: Parameters<typeof diff>[0]) => provideSql(diff(input)),
    set: (input: Parameters<typeof setOverride>[0]) => invalidateRuntimeCache(setOverride(input)),
    reset: (input: Parameters<typeof resetOverride>[0]) =>
      invalidateRuntimeCache(resetOverride(input)),
    import: (input: Parameters<typeof importOverride>[0]) =>
      invalidateRuntimeCache(importOverride(input)),
    export: (projectId?: ProjectId) => provideSql(exportOverride(projectId)),
    status: (projectId?: ProjectId) => provideSql(status(projectId)),
    readEnvironment: provideSql(readCivilizationEnvironmentConfig()),
    readProject: (projectId: ProjectId) => provideSql(readCivilizationProjectConfig(projectId)),
  } as const;
});

export class CivilizationConfigService extends Context.Service<
  CivilizationConfigService,
  Effect.Success<typeof make>
>()("t3/civilization/ConfigService/CivilizationConfigService") {}

export const layer = Layer.effect(CivilizationConfigService, make);
