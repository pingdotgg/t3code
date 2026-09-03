/**
 * GrokSkills — skill discovery for the `$` picker via `grok inspect --json`.
 *
 * Unlike Claude Code, the Grok CLI reports its full skill catalog itself:
 * `grok inspect --json` returns `skills[]` with `name`, `description`,
 * `source.type` (`user` / `project` / `bundled` / `plugin`), `source.path`
 * (the absolute `SKILL.md` path), and `userInvocable`. Asking the CLI beats
 * scanning the filesystem because the catalog honors Grok's own skill config
 * (ignore lists, disabled skills) and includes plugin skills, which live
 * three levels deep under `~/.grok/installed-plugins/` where a flat scan
 * cannot see them. This mirrors how the Codex app-server reports skills over
 * `skills/list`. Probe failures stay typed so workspace snapshots do not
 * cache an empty catalog; machine-level discovery recovers them to an empty
 * list without degrading the provider.
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;

class GrokSkillsProbeError extends Schema.TaggedErrorClass<GrokSkillsProbeError>()(
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

/**
 * Map `grok inspect --json` output onto provider skills. Entries without a
 * name or a filesystem path are skipped; `userInvocable: false` skills are
 * kept but disabled so pickers that filter on `enabled` hide them.
 */
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

export function parseGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> {
  return decodeGrokInspectSkills(stdout) ?? [];
}

/**
 * Run `grok inspect --json` and map the reported catalog onto provider
 * skills. Callers that need best-effort discovery can recover this effect to
 * an empty list; workspace callers leave failures typed so they are not cached.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = grokSettings.binaryPath || "grok";
  const inspectResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
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
