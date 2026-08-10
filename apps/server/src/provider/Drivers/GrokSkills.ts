/**
 * GrokSkills — discover Grok Build skills for the `$` picker.
 *
 * Grok resolves skills from many roots (user, project, bundled, plugins,
 * Claude/Cursor compat, config paths). Rather than reimplement that graph,
 * we run `grok inspect --json` with the workspace cwd and map its `skills`
 * array into `ServerProviderSkill` entries.
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

const INSPECT_TIMEOUT_MS = 4_000;

type GrokInspectSkillSource = {
  readonly type?: string;
  readonly path?: string;
};

type GrokInspectSkill = {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocable?: boolean;
  readonly source?: GrokInspectSkillSource;
};

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the `skills` array from a `grok inspect --json` document into the
 * provider snapshot shape. Malformed entries are skipped so a broken skill
 * never degrades the whole list.
 */
export function parseGrokInspectSkills(
  inspectDocument: unknown,
): ReadonlyArray<ServerProviderSkill> {
  if (typeof inspectDocument !== "object" || inspectDocument === null) {
    return [];
  }

  const skillsValue = (inspectDocument as { readonly skills?: unknown }).skills;
  if (!Array.isArray(skillsValue)) {
    return [];
  }

  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const entry of skillsValue) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const skill = entry as GrokInspectSkill;
    const name = nonEmptyTrimmed(skill.name);
    if (!name) {
      continue;
    }

    const sourcePath = nonEmptyTrimmed(skill.source?.path);
    if (!sourcePath) {
      continue;
    }

    const description = nonEmptyTrimmed(skill.description);
    const scope = nonEmptyTrimmed(skill.source?.type);
    // userInvocable false keeps the skill listed but out of the `$` picker
    // (and out of auto-invoke advertising in Grok itself).
    const enabled = skill.userInvocable !== false;

    skillsByName.set(name, {
      name,
      path: sourcePath,
      enabled,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseGrokInspectSkillsJson(
  raw: string,
): ReadonlyArray<ServerProviderSkill> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  return parseGrokInspectSkills(parsed);
}

/**
 * Enumerate Grok skills for a workspace by shelling out to `grok inspect --json`.
 * Best-effort: spawn/timeout/parse failures yield an empty list so the provider
 * snapshot still succeeds.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = grokSettings.binaryPath || "grok";
  const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
    env: environment,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (!spawnCommand) {
    return [];
  }

  const resultOption = yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(cwd ? { cwd } : {}),
    }),
  ).pipe(
    Effect.timeoutOption(INSPECT_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );

  if (Option.isNone(resultOption)) {
    return [];
  }
  const result = resultOption.value;
  if (result.code !== 0) {
    return [];
  }

  // inspect writes JSON on stdout; tolerate accidental stderr noise by
  // preferring stdout and only falling back when stdout is empty.
  const raw = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
  return parseGrokInspectSkillsJson(raw);
});
