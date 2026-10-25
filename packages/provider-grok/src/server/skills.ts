// The CLI catalog honors ignored/disabled skills and nested plugin skills that flat scans miss.
import type { ServerProviderSkill } from "@t3tools/contracts";
import type { GrokSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { grokProbeEnvironment } from "./probeEnvironment.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;
// The composer's chip rule, anchored to the message start, so `$25` never names a skill.
const LEADING_SKILL_MENTION = new RegExp(`^\\s*${SKILL_MENTION_PATTERN.source}`, "u");

/** A message opening with a mention, such as `deploy` and ` ship it` for `$deploy ship it`. */
export function leadingGrokSkillMention(
  text: string,
): { readonly name: string; readonly rest: string } | undefined {
  const match = LEADING_SKILL_MENTION.exec(text);
  if (match?.[2] === undefined) return undefined;
  return { name: match[2], rest: text.slice(match[0].length) };
}

class GrokSkillsProbeError extends Schema.TaggedError<GrokSkillsProbeError>()(
  "GrokSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`grok inspect --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

function decodeGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source =
      typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : undefined;
    const path = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !path) {
      continue;
    }
    const scope = typeof source?.type === "string" ? source.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: record.userInvocable !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = grokSettings.binaryPath || "grok";
  const probeEnvironment = grokProbeEnvironment(environment);
  const inspectResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: probeEnvironment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: probeEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(inspectResult)) {
    return yield* new GrokSkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const output = inspectResult.value;
  if (output.code !== 0) {
    return yield* new GrokSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  const skills = decodeGrokInspectSkills(output.stdout);
  if (!skills) {
    return yield* new GrokSkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }
  return skills;
});
