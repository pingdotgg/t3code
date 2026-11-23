import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const COPILOT_SKILLS_PROBE_TIMEOUT_MS = 4_000;
const COPILOT_SKILL_LIST_ARGS = ["skill", "list", "--json"] as const;
const COPILOT_SKILL_COMMAND_HINT = "instructions for the skill";
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*(?:\r?\n|$))/u;
const USER_INVOCABLE_FALSE_PATTERN =
  /^[ \t]*user-invocable[ \t]*:[ \t]*(?:false|no|off)[ \t]*(?:#.*)?$/imu;
// The composer's chip rule, anchored to the message start, so `$25` never names a skill.
const LEADING_SKILL_MENTION = new RegExp(`^\\s*${SKILL_MENTION_PATTERN.source}`, "u");

const CopilotRawSkillEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  description: Schema.optional(Schema.Unknown),
  source: Schema.optional(Schema.Unknown),
  enabled: Schema.optional(Schema.Unknown),
});

const decodeCopilotRawSkillList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodeCopilotRawSkillEntry = Schema.decodeUnknownOption(CopilotRawSkillEntry);

export class CopilotSkillsProbeError extends Schema.TaggedError<
  CopilotSkillsProbeError,
  { readonly brand: unique symbol }
>()("CopilotSkillsProbeError", {
  stage: Schema.Literals(["resolve", "spawn", "timeout", "exit", "decode"]),
  cwd: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`copilot skill list --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/** A message opening with a mention, such as `deploy` and ` ship it` for `$deploy ship it`. */
export function leadingCopilotSkillMention(
  text: string,
): { readonly name: string; readonly rest: string } | undefined {
  const match = LEADING_SKILL_MENTION.exec(text);
  if (match?.[2] === undefined) return undefined;
  return { name: match[2], rest: text.slice(match[0].length) };
}

function normalizeCopilotSkillScope(source: string | undefined): string | undefined {
  const trimmed = source?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "project") {
    return "project";
  }
  if (normalized === "personal" || normalized.startsWith("personal-")) {
    return "personal";
  }
  if (normalized === "builtin") {
    return "system";
  }
  return trimmed;
}

export function decodeCopilotSkillList(
  stdout: string,
): ReadonlyArray<ServerProviderSkill> | undefined {
  const parsed = decodeCopilotRawSkillList(stdout);
  if (Option.isNone(parsed)) {
    return undefined;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const candidate of parsed.value) {
    const entry = decodeCopilotRawSkillEntry(candidate);
    if (Option.isNone(entry)) {
      continue;
    }
    const raw = entry.value;
    const name = raw.name.trim();
    const path = raw.path.trim();
    if (!name || !path || skillsByName.has(name)) {
      continue;
    }
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const scope = normalizeCopilotSkillScope(
      typeof raw.source === "string" ? raw.source : undefined,
    );
    skillsByName.set(name, {
      name,
      path,
      enabled: raw.enabled !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function isCopilotSkillSlashCommand(command: ServerProviderSlashCommand): boolean {
  return command.input?.hint?.trim().toLowerCase() === COPILOT_SKILL_COMMAND_HINT;
}

/** True when ACP advertises a built-in slash command with the same name as a skill (e.g. `/plan`). */
export function isCopilotBuiltinCommandCollision(
  skillName: string,
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
): boolean {
  const normalized = skillName.trim().toLowerCase();
  return slashCommands.some(
    (command) =>
      command.name.trim().toLowerCase() === normalized && !isCopilotSkillSlashCommand(command),
  );
}

export function filterCopilotSlashCommands(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (skills.length === 0) {
    return slashCommands;
  }
  const skillNames = new Set(skills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter(
    (command) =>
      !(isCopilotSkillSlashCommand(command) && skillNames.has(command.name.trim().toLowerCase())),
  );
}

export function applyCopilotDiscoveredSkills(
  provider: ServerProvider,
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProvider {
  return {
    ...provider,
    skills,
    slashCommands: filterCopilotSlashCommands(provider.slashCommands, skills),
  };
}

function isSkillFrontmatterNonUserInvocable(contents: string): boolean {
  const match = FRONTMATTER_PATTERN.exec(contents);
  return match?.[1] !== undefined && USER_INVOCABLE_FALSE_PATTERN.test(match[1]);
}

// Untraced helper: runs within discoverCopilotSkills's span to annotate frontmatter per skill.
const annotateCopilotSkillInvocability = Effect.fnUntraced(function* (
  skills: ReadonlyArray<ServerProviderSkill>,
) {
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(fileSystem) || Option.isNone(path) || skills.length === 0) {
    return skills;
  }
  const fs = fileSystem.value;
  const pathService = path.value;
  return yield* Effect.forEach(
    skills,
    (skill) => {
      const skillFile = skill.path.toLowerCase().endsWith(".md")
        ? skill.path
        : pathService.join(skill.path, "SKILL.md");
      return fs.readFileString(skillFile).pipe(
        Effect.map((contents) =>
          isSkillFrontmatterNonUserInvocable(contents) ? { ...skill, userInvocable: false } : skill,
        ),
        Effect.orElseSucceed(() => skill),
      );
    },
    { concurrency: 8 },
  );
});

export const discoverCopilotSkills = Effect.fn("discoverCopilotSkills")(function* (input: {
  readonly settings: AcpRegistrySettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const probeEnvironment = providerProbeEnvironment(input.environment ?? {});
  const cwd = input.cwd;
  const cwdOption = cwd ? { cwd } : {};

  const probeResult = yield* Effect.gen(function* () {
    const resolved = yield* catalog.resolve(input.settings, cwd ?? "", probeEnvironment).pipe(
      Effect.mapError(
        (cause) =>
          new CopilotSkillsProbeError({
            stage: "resolve",
            ...cwdOption,
            cause,
          }),
      ),
    );
    const spawnEnvironment = resolved.spawn.env ?? probeEnvironment;
    const spawnCommand = yield* resolveSpawnCommand(
      resolved.spawn.command,
      COPILOT_SKILL_LIST_ARGS,
      { env: spawnEnvironment },
    );
    return yield* spawnAndCollect(
      resolved.spawn.command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...cwdOption,
        env: spawnEnvironment,
        shell: spawnCommand.shell,
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CopilotSkillsProbeError({
            stage: "spawn",
            ...cwdOption,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs(
        "acpRegistry",
        COPILOT_SKILLS_PROBE_TIMEOUT_MS,
        probeEnvironment,
      ),
    ),
  );

  if (Option.isNone(probeResult)) {
    return yield* new CopilotSkillsProbeError({
      stage: "timeout",
      ...cwdOption,
    });
  }
  const output = probeResult.value;
  if (output.code !== 0) {
    return yield* new CopilotSkillsProbeError({
      stage: "exit",
      ...cwdOption,
      exitCode: output.code,
    });
  }
  const skills = decodeCopilotSkillList(output.stdout);
  if (!skills) {
    return yield* new CopilotSkillsProbeError({
      stage: "decode",
      ...cwdOption,
    });
  }
  return yield* annotateCopilotSkillInvocability(skills);
});
