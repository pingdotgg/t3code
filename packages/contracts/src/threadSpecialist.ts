import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Stable project-scoped handle for a durable specialist thread, like OpenRig's
 * `dev-ui@factory`. Lowercase slug so agents can address it without fuzzy title match.
 */
export const ThreadSpecialistKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /^[a-z][a-z0-9-]{0,62}$/.test(value) ? true : "Lowercase slug (a-z, 0-9, hyphens).",
  ),
);
export type ThreadSpecialistKey = typeof ThreadSpecialistKey.Type;

export const ThreadSpecialistLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ThreadSpecialistLabel = typeof ThreadSpecialistLabel.Type;

export const ThreadSpecialistInstructions = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export type ThreadSpecialistInstructions = typeof ThreadSpecialistInstructions.Type;

/** Skill name from provider discovery that this role should receive automatically. */
export const ThreadSpecialistSkillName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ThreadSpecialistSkillName = typeof ThreadSpecialistSkillName.Type;

export const ThreadSpecialistSkillNames = Schema.Array(ThreadSpecialistSkillName).check(
  Schema.isMaxLength(32),
);
export type ThreadSpecialistSkillNames = typeof ThreadSpecialistSkillNames.Type;

const ThreadSpecialistMcpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    value === "t3-code" || value === "t3-code-direct" ? "Reserved." : true,
  ),
);

export const ThreadSpecialistMcpHttpServer = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  headers: Schema.optional(
    Schema.Record(Schema.String, TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  ),
});
export type ThreadSpecialistMcpHttpServer = typeof ThreadSpecialistMcpHttpServer.Type;

export const ThreadSpecialistMcpStdioServer = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  args: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1_024)))),
  env: Schema.optional(
    Schema.Record(Schema.String, TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  ),
});
export type ThreadSpecialistMcpStdioServer = typeof ThreadSpecialistMcpStdioServer.Type;

export const ThreadSpecialistMcpServer = Schema.Union([
  ThreadSpecialistMcpHttpServer,
  ThreadSpecialistMcpStdioServer,
]);
export type ThreadSpecialistMcpServer = typeof ThreadSpecialistMcpServer.Type;

export const ThreadSpecialistMcpServers = Schema.Record(
  ThreadSpecialistMcpServerName,
  ThreadSpecialistMcpServer,
).check(
  Schema.makeFilter((value) => (Object.keys(value).length <= 16 ? true : "At most 16 servers.")),
);
export type ThreadSpecialistMcpServers = typeof ThreadSpecialistMcpServers.Type;

export const ThreadSpecialist = Schema.Struct({
  key: ThreadSpecialistKey,
  label: ThreadSpecialistLabel,
  /** Domain brief injected into the agent turn for this role. */
  instructions: Schema.optional(ThreadSpecialistInstructions),
  /**
   * Skill names attached to this role (OpenRig-style loadout). Agents in the role
   * are told to use them; discovery still comes from the provider skill roots.
   */
  skills: Schema.optional(ThreadSpecialistSkillNames),
  /**
   * Extra MCP servers merged into the provider session for this role, like OpenRig
   * projecting role MCP into Claude `.mcp.json` / Codex `config.toml`.
   */
  mcpServers: Schema.optional(ThreadSpecialistMcpServers),
});
export type ThreadSpecialist = typeof ThreadSpecialist.Type;

const sortedSkillNames = (skills: ThreadSpecialistSkillNames | undefined) =>
  skills === undefined ? undefined : [...skills].sort((left, right) => left.localeCompare(right));

const mcpServersEqual = (
  left: ThreadSpecialistMcpServers | undefined,
  right: ThreadSpecialistMcpServers | undefined,
) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** True when two bindings would project the same role tools and brief. */
export const specialistBindingsEqual = (
  left: ThreadSpecialist | undefined,
  right: ThreadSpecialist | undefined,
) => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.key === right.key &&
    left.label === right.label &&
    left.instructions === right.instructions &&
    JSON.stringify(sortedSkillNames(left.skills)) ===
      JSON.stringify(sortedSkillNames(right.skills)) &&
    mcpServersEqual(left.mcpServers, right.mcpServers)
  );
};

/** Merge create/rebind fields onto a prior specialist, keeping unset fields. */
export const resolveSpecialistBinding = (input: {
  readonly key: ThreadSpecialistKey;
  readonly label?: ThreadSpecialistLabel;
  readonly instructions?: ThreadSpecialistInstructions;
  readonly skills?: ThreadSpecialistSkillNames;
  readonly mcpServers?: ThreadSpecialistMcpServers;
  readonly prior?: ThreadSpecialist;
}): ThreadSpecialist => {
  const label = input.label ?? input.prior?.label ?? input.key;
  const instructions =
    input.instructions !== undefined
      ? input.instructions
      : input.prior?.instructions !== undefined
        ? input.prior.instructions
        : undefined;
  const skills =
    input.skills !== undefined
      ? input.skills
      : input.prior?.skills !== undefined
        ? input.prior.skills
        : undefined;
  const mcpServers =
    input.mcpServers !== undefined
      ? input.mcpServers
      : input.prior?.mcpServers !== undefined
        ? input.prior.mcpServers
        : undefined;
  return {
    key: input.key,
    label,
    ...(instructions === undefined ? {} : { instructions }),
    ...(skills === undefined ? {} : { skills }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
};

/**
 * Prompt block for role-scoped brief + skills. Empty when the binding carries neither.
 * MCP servers are injected into the provider session separately.
 */
export const formatSpecialistRoleLoadout = (
  specialist: ThreadSpecialist | undefined,
): string | undefined => {
  if (specialist === undefined) return undefined;
  const skills = specialist.skills ?? [];
  if (specialist.instructions === undefined && skills.length === 0) return undefined;
  const lines = [
    `## T3 Code specialist role: ${specialist.label} (\`${specialist.key}\`)`,
    "",
    "You are bound to this durable specialist role. Follow its brief and prefer its skills.",
  ];
  if (specialist.instructions !== undefined) {
    lines.push("", "### Role brief", "", specialist.instructions);
  }
  if (skills.length > 0) {
    lines.push(
      "",
      "### Role skills",
      "",
      "These skills belong to this role. Invoke them when they apply:",
      ...skills.map((name) => `- \`${name}\``),
    );
  }
  return lines.join("\n");
};

/** Role MCP entries for provider session merge. Reserved T3 names are already schema-rejected. */
export const specialistMcpServerEntries = (
  specialist: ThreadSpecialist | undefined,
): ReadonlyArray<readonly [string, ThreadSpecialistMcpServer]> => {
  if (specialist?.mcpServers === undefined) return [];
  return Object.entries(specialist.mcpServers).sort(([left], [right]) => left.localeCompare(right));
};

/** Drop one skill from the role loadout; omits `skills` when none remain. */
export const withoutSpecialistSkill = (
  specialist: ThreadSpecialist,
  skillName: string,
): ThreadSpecialist => {
  const skills = (specialist.skills ?? []).filter((name) => name !== skillName);
  const { skills: _removed, ...rest } = specialist;
  return skills.length === 0 ? rest : { ...rest, skills };
};

/** Drop one MCP server from the role loadout; omits `mcpServers` when none remain. */
export const withoutSpecialistMcpServer = (
  specialist: ThreadSpecialist,
  serverName: string,
): ThreadSpecialist => {
  if (specialist.mcpServers === undefined || !(serverName in specialist.mcpServers)) {
    return specialist;
  }
  const { [serverName]: _removed, ...remaining } = specialist.mcpServers;
  const { mcpServers: _servers, ...rest } = specialist;
  return Object.keys(remaining).length === 0 ? rest : { ...rest, mcpServers: remaining };
};
