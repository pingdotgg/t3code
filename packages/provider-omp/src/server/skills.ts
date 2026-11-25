import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const SkillList = Schema.fromJsonString(
  Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        filePath: Schema.String,
        source: Schema.String,
        hide: Schema.Boolean,
      }),
    ),
  }),
);
const decodeSkills = Schema.decodeOption(SkillList);
const decodeSkillCommandsSetting = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ value: Schema.Boolean })),
);

export function readOmpSkills(stdout: string): ReadonlyArray<ServerProviderSkill> | undefined {
  const result = decodeSkills(stdout);
  if (result._tag === "None") return undefined;
  return result.value.skills.flatMap((skill) => {
    const name = skill.name.trim();
    const path = skill.filePath.trim();
    if (!name || !path) return [];
    const description = skill.description.trim();
    const scope = skill.source.split(":").at(-1)?.trim();
    return [
      {
        name,
        path,
        enabled: true,
        ...(description ? { description } : {}),
        ...(scope ? { scope } : {}),
        ...(skill.hide ? { userInvocationOnly: true } : {}),
      },
    ];
  });
}

export function readOmpSkillCommandsEnabled(stdout: string): boolean | undefined {
  const result = decodeSkillCommandsSetting(stdout);
  return result._tag === "Some" ? result.value.value : undefined;
}
