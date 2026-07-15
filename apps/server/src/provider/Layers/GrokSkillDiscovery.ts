import {
  type GrokSettings,
  type ServerProviderSkill,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

export const GROK_SKILL_DISCOVERY_TIMEOUT_MS = 10_000;

const GrokInspectSkillSource = Schema.Struct({
  type: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  name: Schema.optional(Schema.String),
  plugin: Schema.optional(Schema.String),
});

const GrokInspectSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  source: GrokInspectSkillSource,
  userInvocable: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  displayName: Schema.optional(Schema.String),
  shortDescription: Schema.optional(Schema.String),
});

const GrokInspectOutput = Schema.Struct({
  skills: Schema.Array(GrokInspectSkill),
});

const GrokInspectOutputJson = Schema.fromJsonString(GrokInspectOutput);
const decodeGrokInspectOutputJson = Schema.decodeUnknownEffect(GrokInspectOutputJson);

export class GrokSkillDiscoveryError extends Schema.TaggedErrorClass<GrokSkillDiscoveryError>()(
  "GrokSkillDiscoveryError",
  {
    operation: Schema.Literals(["run", "decode", "timeout"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Grok skill discovery failed during ${this.operation}: ${this.detail}`;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function scopeFromSource(source: typeof GrokInspectSkillSource.Type): string | undefined {
  const type = nonEmpty(source.type);
  if (!type) return undefined;
  if (type !== "plugin") return type;
  const pluginName = nonEmpty(source.plugin) ?? nonEmpty(source.name);
  return pluginName ? `plugin:${pluginName}` : type;
}

export const parseGrokInspectSkills = Effect.fn("parseGrokInspectSkills")(function* (
  output: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, GrokSkillDiscoveryError> {
  const parsed = yield* decodeGrokInspectOutputJson(output).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillDiscoveryError({
          operation: "decode",
          detail: "The `grok inspect --json` response did not match the expected schema.",
          cause,
        }),
    ),
  );

  return parsed.skills
    .filter((skill) => skill.userInvocable !== false)
    .map((skill): ServerProviderSkill => {
      const description = nonEmpty(skill.description);
      const displayName = nonEmpty(skill.displayName);
      const shortDescription = nonEmpty(skill.shortDescription);
      const scope = scopeFromSource(skill.source);
      return {
        name: skill.name,
        path: skill.source.path,
        enabled: skill.enabled ?? skill.disabled !== true,
        ...(description ? { description } : {}),
        ...(scope ? { scope } : {}),
        ...(displayName ? { displayName } : {}),
        ...(shortDescription ? { shortDescription } : {}),
      };
    });
});

export const listGrokSkills = Effect.fn("listGrokSkills")(function* (input: {
  readonly settings: Pick<GrokSettings, "binaryPath">;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeout?: Duration.Input;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  GrokSkillDiscoveryError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const binaryPath = input.settings.binaryPath || "grok";
  const timeout = input.timeout ?? Duration.millis(GROK_SKILL_DISCOVERY_TIMEOUT_MS);
  const spawnCommand = yield* resolveSpawnCommand(
    binaryPath,
    ["--cwd", input.cwd, "inspect", "--json"],
    input.environment ? { env: input.environment } : {},
  ).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillDiscoveryError({
          operation: "run",
          detail: "The Grok executable could not be resolved.",
          cause,
        }),
    ),
  );

  const commandResult = yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      ...(input.environment ? { env: input.environment } : {}),
      shell: spawnCommand.shell,
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillDiscoveryError({
          operation: "run",
          detail: "The Grok inspect process could not be executed.",
          cause,
        }),
    ),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        new GrokSkillDiscoveryError({
          operation: "timeout",
          detail: `The Grok inspect process exceeded ${Duration.toMillis(timeout)}ms.`,
        }),
    }),
  );

  if (commandResult.code !== 0) {
    return yield* new GrokSkillDiscoveryError({
      operation: "run",
      detail: `The Grok inspect process exited with code ${commandResult.code}.`,
    });
  }

  return yield* parseGrokInspectSkills(commandResult.stdout);
});
