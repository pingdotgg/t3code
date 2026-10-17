import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type JsonRecord = Record<string, unknown>;

type RichProfile = {
  readonly label: string;
  readonly traits: ReadonlyArray<string>;
  readonly axiom: string;
  readonly voice: string;
  readonly styleText: string;
};

const BUILT_IN_RICH_PROFILES: Readonly<Record<string, RichProfile>> = {
  calm: {
    label: "Stoic Architect",
    traits: ["deliberate", "composed", "structural"],
    axiom: "Build carefully; clarity and sound structure outlast urgency.",
    voice: "Measured, composed, and architectural without becoming ceremonial.",
    styleText:
      "Use a distinctly stoic, architectural voice while staying concise, task-focused, and fully subordinate to the user's instructions.",
  },
  explanatory: {
    label: "Inquisitive Explorer",
    traits: ["curious", "explanatory", "structured"],
    axiom: "Understand the terrain before choosing the path.",
    voice: "Curious and lucid, surfacing useful reasoning without wandering beyond scope.",
    styleText:
      "Use an inquisitive, explanatory voice that makes relevant structure visible while remaining disciplined about the requested task.",
  },
  reserved: {
    label: "Skeptical Auditor",
    traits: ["skeptical", "precise", "evidence-minded"],
    axiom: "Claims earn confidence through evidence, not posture.",
    voice: "Reserved and exacting, distinguishing facts, assumptions, and uncertainty.",
    styleText:
      "Use a skeptical-auditor voice that is precise about evidence and uncertainty without becoming obstructive or changing the requested scope.",
  },
  conversational: {
    label: "Pragmatic Craftsman",
    traits: ["pragmatic", "grounded", "craft-focused"],
    axiom: "Prefer the smallest durable solution that does the job well.",
    voice: "Grounded and practical, favoring concrete tradeoffs over flourish.",
    styleText:
      "Use a pragmatic craftsman voice focused on concrete, maintainable outcomes while respecting the exact requested scope and constraints.",
  },
};

const BUILT_IN_MILD_PROFILES: Readonly<
  Record<
    string,
    {
      readonly label: string;
      readonly traits: ReadonlyArray<string>;
      readonly styleText: string;
    }
  >
> = {
  calm: {
    label: "Calm",
    traits: ["calm", "concise"],
    styleText: "Prefer a calm, concise style without changing task priorities.",
  },
  explanatory: {
    label: "Explanatory",
    traits: ["explanatory", "structured"],
    styleText: "Prefer mildly explanatory, structured phrasing while staying task-focused.",
  },
  reserved: {
    label: "Reserved",
    traits: ["reserved", "precise"],
    styleText: "Prefer a reserved, precise presentation without changing task priorities.",
  },
  conversational: {
    label: "Conversational",
    traits: ["conversational", "restrained"],
    styleText: "Prefer mildly conversational wording while remaining restrained and task-focused.",
  },
};

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const conservativeRichProfile = (entry: JsonRecord): RichProfile => {
  if (
    typeof entry.label !== "string" ||
    !Array.isArray(entry.traits) ||
    !entry.traits.every((trait) => typeof trait === "string") ||
    typeof entry.styleText !== "string"
  ) {
    throw new Error("Cannot migrate invalid Civilization v1 personality profile entry.");
  }
  return {
    label: entry.label,
    traits: entry.traits,
    axiom: "Keep the stored personality subordinate to the requested task.",
    voice: `Express the stored ${entry.label} profile distinctly without changing task priorities.`,
    styleText: entry.styleText,
  };
};

const matchesBuiltInMildProfile = (entry: JsonRecord): boolean => {
  if (typeof entry.id !== "string") return false;
  const mild = BUILT_IN_MILD_PROFILES[entry.id];
  if (mild === undefined) return false;
  return (
    entry.label === mild.label &&
    Array.isArray(entry.traits) &&
    entry.traits.length === mild.traits.length &&
    entry.traits.every((trait, index) => trait === mild.traits[index]) &&
    entry.styleText === mild.styleText
  );
};

const migratePersonalityEntry = (value: unknown): unknown => {
  const entry = asRecord(value);
  if (entry === undefined) {
    throw new Error("Cannot migrate invalid Civilization v1 personality profile entry.");
  }
  const builtIn =
    matchesBuiltInMildProfile(entry) && typeof entry.id === "string"
      ? BUILT_IN_RICH_PROFILES[entry.id]
      : undefined;
  return {
    ...entry,
    rich: builtIn ?? conservativeRichProfile(entry),
  };
};

const migrateOverrideJson = (raw: string): string => {
  const parsed = asRecord(JSON.parse(raw) as unknown);
  if (parsed === undefined) {
    throw new Error("Cannot migrate invalid Civilization configuration override JSON.");
  }
  if (parsed.version === 2) return raw;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported Civilization configuration version '${String(parsed.version)}'.`);
  }

  const personalities = asRecord(parsed.personalities);
  if (personalities === undefined || personalities.pools === undefined) {
    return JSON.stringify({ ...parsed, version: 2 });
  }
  if (!Array.isArray(personalities.pools)) {
    throw new Error("Cannot migrate invalid Civilization v1 personality pools.");
  }

  const pools = personalities.pools.map((value) => {
    const pool = asRecord(value);
    if (pool === undefined || !Array.isArray(pool.entries)) {
      throw new Error("Cannot migrate invalid Civilization v1 personality pool.");
    }
    return {
      ...pool,
      entries: pool.entries.map(migratePersonalityEntry),
    };
  });

  return JSON.stringify({
    ...parsed,
    version: 2,
    personalities: { ...personalities, pools },
  });
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN profile_rich_label TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN profile_rich_traits_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN profile_rich_axiom TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN profile_rich_voice TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN profile_rich_style_text TEXT NOT NULL DEFAULT ''`;

  yield* sql`
    UPDATE civilization_citizens
    SET
      profile_rich_label = CASE
        WHEN profile_entry_id = 'calm'
          AND profile_label = 'Calm'
          AND profile_traits_json = '["calm","concise"]'
          AND profile_style_text = 'Prefer a calm, concise style without changing task priorities.'
          THEN 'Stoic Architect'
        WHEN profile_entry_id = 'explanatory'
          AND profile_label = 'Explanatory'
          AND profile_traits_json = '["explanatory","structured"]'
          AND profile_style_text = 'Prefer mildly explanatory, structured phrasing while staying task-focused.'
          THEN 'Inquisitive Explorer'
        WHEN profile_entry_id = 'reserved'
          AND profile_label = 'Reserved'
          AND profile_traits_json = '["reserved","precise"]'
          AND profile_style_text = 'Prefer a reserved, precise presentation without changing task priorities.'
          THEN 'Skeptical Auditor'
        WHEN profile_entry_id = 'conversational'
          AND profile_label = 'Conversational'
          AND profile_traits_json = '["conversational","restrained"]'
          AND profile_style_text = 'Prefer mildly conversational wording while remaining restrained and task-focused.'
          THEN 'Pragmatic Craftsman'
        ELSE profile_label
      END,
      profile_rich_traits_json = CASE
        WHEN profile_entry_id = 'calm'
          AND profile_label = 'Calm'
          AND profile_traits_json = '["calm","concise"]'
          AND profile_style_text = 'Prefer a calm, concise style without changing task priorities.'
          THEN '["deliberate","composed","structural"]'
        WHEN profile_entry_id = 'explanatory'
          AND profile_label = 'Explanatory'
          AND profile_traits_json = '["explanatory","structured"]'
          AND profile_style_text = 'Prefer mildly explanatory, structured phrasing while staying task-focused.'
          THEN '["curious","explanatory","structured"]'
        WHEN profile_entry_id = 'reserved'
          AND profile_label = 'Reserved'
          AND profile_traits_json = '["reserved","precise"]'
          AND profile_style_text = 'Prefer a reserved, precise presentation without changing task priorities.'
          THEN '["skeptical","precise","evidence-minded"]'
        WHEN profile_entry_id = 'conversational'
          AND profile_label = 'Conversational'
          AND profile_traits_json = '["conversational","restrained"]'
          AND profile_style_text = 'Prefer mildly conversational wording while remaining restrained and task-focused.'
          THEN '["pragmatic","grounded","craft-focused"]'
        ELSE profile_traits_json
      END
  `;

  yield* sql`
    UPDATE civilization_citizens
    SET
      profile_rich_axiom = CASE
        WHEN profile_entry_id = 'calm'
          AND profile_label = 'Calm'
          AND profile_traits_json = '["calm","concise"]'
          AND profile_style_text = 'Prefer a calm, concise style without changing task priorities.'
          THEN 'Build carefully; clarity and sound structure outlast urgency.'
        WHEN profile_entry_id = 'explanatory'
          AND profile_label = 'Explanatory'
          AND profile_traits_json = '["explanatory","structured"]'
          AND profile_style_text = 'Prefer mildly explanatory, structured phrasing while staying task-focused.'
          THEN 'Understand the terrain before choosing the path.'
        WHEN profile_entry_id = 'reserved'
          AND profile_label = 'Reserved'
          AND profile_traits_json = '["reserved","precise"]'
          AND profile_style_text = 'Prefer a reserved, precise presentation without changing task priorities.'
          THEN 'Claims earn confidence through evidence, not posture.'
        WHEN profile_entry_id = 'conversational'
          AND profile_label = 'Conversational'
          AND profile_traits_json = '["conversational","restrained"]'
          AND profile_style_text = 'Prefer mildly conversational wording while remaining restrained and task-focused.'
          THEN 'Prefer the smallest durable solution that does the job well.'
        ELSE 'Keep the stored personality subordinate to the requested task.'
      END,
      profile_rich_voice = CASE
        WHEN profile_entry_id = 'calm'
          AND profile_label = 'Calm'
          AND profile_traits_json = '["calm","concise"]'
          AND profile_style_text = 'Prefer a calm, concise style without changing task priorities.'
          THEN 'Measured, composed, and architectural without becoming ceremonial.'
        WHEN profile_entry_id = 'explanatory'
          AND profile_label = 'Explanatory'
          AND profile_traits_json = '["explanatory","structured"]'
          AND profile_style_text = 'Prefer mildly explanatory, structured phrasing while staying task-focused.'
          THEN 'Curious and lucid, surfacing useful reasoning without wandering beyond scope.'
        WHEN profile_entry_id = 'reserved'
          AND profile_label = 'Reserved'
          AND profile_traits_json = '["reserved","precise"]'
          AND profile_style_text = 'Prefer a reserved, precise presentation without changing task priorities.'
          THEN 'Reserved and exacting, distinguishing facts, assumptions, and uncertainty.'
        WHEN profile_entry_id = 'conversational'
          AND profile_label = 'Conversational'
          AND profile_traits_json = '["conversational","restrained"]'
          AND profile_style_text = 'Prefer mildly conversational wording while remaining restrained and task-focused.'
          THEN 'Grounded and practical, favoring concrete tradeoffs over flourish.'
        ELSE 'Express the stored profile distinctly without changing task priorities.'
      END,
      profile_rich_style_text = CASE
        WHEN profile_entry_id = 'calm'
          AND profile_label = 'Calm'
          AND profile_traits_json = '["calm","concise"]'
          AND profile_style_text = 'Prefer a calm, concise style without changing task priorities.'
          THEN 'Use a distinctly stoic, architectural voice while staying concise, task-focused, and fully subordinate to the user''s instructions.'
        WHEN profile_entry_id = 'explanatory'
          AND profile_label = 'Explanatory'
          AND profile_traits_json = '["explanatory","structured"]'
          AND profile_style_text = 'Prefer mildly explanatory, structured phrasing while staying task-focused.'
          THEN 'Use an inquisitive, explanatory voice that makes relevant structure visible while remaining disciplined about the requested task.'
        WHEN profile_entry_id = 'reserved'
          AND profile_label = 'Reserved'
          AND profile_traits_json = '["reserved","precise"]'
          AND profile_style_text = 'Prefer a reserved, precise presentation without changing task priorities.'
          THEN 'Use a skeptical-auditor voice that is precise about evidence and uncertainty without becoming obstructive or changing the requested scope.'
        WHEN profile_entry_id = 'conversational'
          AND profile_label = 'Conversational'
          AND profile_traits_json = '["conversational","restrained"]'
          AND profile_style_text = 'Prefer mildly conversational wording while remaining restrained and task-focused.'
          THEN 'Use a pragmatic craftsman voice focused on concrete, maintainable outcomes while respecting the exact requested scope and constraints.'
        ELSE profile_style_text
      END
  `;

  const environmentRows = yield* sql<{ readonly override_json: string | null }>`
    SELECT override_json FROM civilization_environment_config WHERE override_json IS NOT NULL
  `;
  for (const row of environmentRows) {
    const migrated = migrateOverrideJson(row.override_json!);
    if (migrated !== row.override_json) {
      yield* sql`
        UPDATE civilization_environment_config
        SET override_json = ${migrated}
        WHERE singleton = 1
      `;
    }
  }

  const projectRows = yield* sql<{ readonly project_id: string; readonly override_json: string }>`
    SELECT project_id, override_json
    FROM civilization_project_config
    WHERE override_json IS NOT NULL
  `;
  for (const row of projectRows) {
    const migrated = migrateOverrideJson(row.override_json);
    if (migrated !== row.override_json) {
      yield* sql`
        UPDATE civilization_project_config
        SET override_json = ${migrated}
        WHERE project_id = ${row.project_id}
      `;
    }
  }
});
