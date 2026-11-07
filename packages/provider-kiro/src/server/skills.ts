import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpSchema from "effect-acp/compat";

const MAX_SKILLS = 128;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1_024;
// Anchored and unambiguous (`\s*` then a literal `$`), so it scans the text once.
const LEADING_MENTION = /^\s*\$(\S+)/;

/**
 * Every global skill the instance's Kiro sessions have advertised since the
 * server started. Kiro reports them only as `available_commands_update` entries
 * with `_meta.kiro.type: "skill"`, and some updates carry none.
 */
export type KiroSkills = SubscriptionRef.SubscriptionRef<ReadonlyArray<ServerProviderSkill>>;

export const makeKiroSkills = (): Effect.Effect<KiroSkills> =>
  SubscriptionRef.make<ReadonlyArray<ServerProviderSkill>>([]);

const decodeKiroSkillMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({
      type: Schema.Literal("skill"),
      resource: Schema.optional(
        Schema.Struct({
          source: Schema.optional(
            Schema.Struct({
              origin: Schema.optional(Schema.Unknown),
              root: Schema.optional(Schema.Unknown),
            }),
          ),
        }),
      ),
    }),
  }),
);

// The store is shared by every project, so a skill Kiro scopes to one workspace stays out.
const isKiroGlobalSkill = (meta: unknown) =>
  Option.match(decodeKiroSkillMeta(meta), {
    onNone: () => false,
    onSome: ({ kiro }) => {
      const source = kiro.resource?.source;
      return source?.origin !== "workspace" && source?.root === undefined;
    },
  });

function kiroSkillsFromCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const seen = new Set<string>();
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    if (skills.length === MAX_SKILLS) break;
    if (!isKiroGlobalSkill(command._meta)) continue;
    const { name } = command;
    if (name.length === 0 || name.length > MAX_NAME_LENGTH || name !== name.trim()) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = command.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    skills.push({
      name,
      ...(description ? { description } : {}),
      path: `acp://skill/${encodeURIComponent(name)}`,
      scope: "agent",
      enabled: true,
    });
  }
  return skills;
}

function mergeKiroSkills(
  current: ReadonlyArray<ServerProviderSkill>,
  incoming: ReadonlyArray<ServerProviderSkill>,
): Option.Option<ReadonlyArray<ServerProviderSkill>> {
  let merged: Array<ServerProviderSkill> | undefined;
  for (const skill of incoming) {
    const list = merged ?? current;
    const key = skill.name.toLowerCase();
    const index = list.findIndex((existing) => existing.name.toLowerCase() === key);
    const existing = list[index];
    if (existing === undefined && list.length === MAX_SKILLS) continue;
    if (existing?.name === skill.name && existing.description === skill.description) continue;
    merged ??= [...current];
    if (existing === undefined) merged.push(skill);
    else merged[index] = skill;
  }
  return Option.fromUndefinedOr(merged);
}

/** Adds an update's skills, replacing same-named ones in place; publishes only on a change. */
export const recordKiroSkills = (
  skills: KiroSkills,
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): Effect.Effect<void> =>
  SubscriptionRef.updateSome(skills, (current) =>
    mergeKiroSkills(current, kiroSkillsFromCommands(commands)),
  );

/**
 * Kiro runs a command only from a leading `/name`, while T3's `$` picker
 * inserts `$name`. Only advertised skills are rewritten, so `$25` stays text.
 */
export const kiroSkillCommandText = (skills: KiroSkills, text: string): Effect.Effect<string> => {
  const match = LEADING_MENTION.exec(text);
  const name = match?.[1];
  if (match === null || name === undefined) return Effect.succeed(text);
  return SubscriptionRef.get(skills).pipe(
    Effect.map((current) =>
      current.some((skill) => skill.name === name)
        ? `/${name}${text.slice(match[0].length)}`
        : text,
    ),
  );
};
