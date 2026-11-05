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
 * The skills the instance's latest Kiro session advertised. Kiro reports them
 * only as `available_commands_update` entries with `_meta.kiro.type: "skill"`.
 */
export type KiroSkills = SubscriptionRef.SubscriptionRef<ReadonlyArray<ServerProviderSkill>>;

export const makeKiroSkills = (): Effect.Effect<KiroSkills> =>
  SubscriptionRef.make<ReadonlyArray<ServerProviderSkill>>([]);

const decodeKiroSkillMeta = Schema.decodeUnknownOption(
  Schema.Struct({ kiro: Schema.Struct({ type: Schema.Literal("skill") }) }),
);

export function kiroSkillsFromCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const seen = new Set<string>();
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    if (skills.length === MAX_SKILLS) break;
    if (Option.isNone(decodeKiroSkillMeta(command._meta))) continue;
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
