/**
 * GrokSkills — surface Grok Build skills on the provider snapshot for the `$`
 * picker. The CLI already discovers skills (`grok inspect --json`); T3 does
 * not walk the filesystem a second time.
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

type GrokInspectSkillSource = {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly plugin_name?: unknown;
};

type GrokInspectSkill = {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly userInvocable?: unknown;
  readonly disabled?: unknown;
  readonly source?: GrokInspectSkillSource;
};

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function inspectScope(source: GrokInspectSkillSource | undefined): string | undefined {
  const type = asTrimmedString(source?.type);
  if (!type) return undefined;
  const pluginName = asTrimmedString(source?.plugin_name);
  return type === "plugin" && pluginName ? `plugin:${pluginName}` : type;
}

export function parseGrokInspectSkills(input: unknown): ReadonlyArray<ServerProviderSkill> {
  if (typeof input !== "object" || input === null) {
    return [];
  }
  const rawSkills = (input as { readonly skills?: unknown }).skills;
  if (!Array.isArray(rawSkills)) {
    return [];
  }

  const skills: ServerProviderSkill[] = [];
  const seen = new Set<string>();
  for (const entry of rawSkills) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const skill = entry as GrokInspectSkill;
    const name = asTrimmedString(skill.name);
    const path = asTrimmedString(skill.source?.path);
    if (!name || !path || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const description = asTrimmedString(skill.description);
    const scope = inspectScope(skill.source);
    const enabled = skill.userInvocable !== false && skill.disabled !== true;
    skills.push({
      name,
      path,
      enabled,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
    });
  }
  return skills;
}

/**
 * Ask the Grok CLI what skills it would load in this cwd. Failure is empty:
 * a broken inspect must not take the provider snapshot down.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = grokSettings.binaryPath || "grok";
  const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
    env: environment,
  }).pipe(Effect.orElseSucceed(() => null));
  if (!spawnCommand) {
    return [];
  }

  const result = yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(cwd ? { cwd } : {}),
    }),
  ).pipe(Effect.orElseSucceed(() => null));
  if (!result || result.code !== 0) {
    return [];
  }

  const parsed = yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(result.stdout).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (parsed === null) {
    return [];
  }
  return parseGrokInspectSkills(parsed);
});
