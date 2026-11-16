import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { MuseSettings } from "../settings.ts";
import {
  DEFAULT_TIMEOUT_MS,
  nonEmptyTrimmed,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import { makeMuseEnvironment } from "./sdk.ts";

const decodeSkills = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      skills: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.String,
          scope: Schema.optional(Schema.String),
          activation: Schema.optional(Schema.String),
          description: Schema.optional(Schema.NullOr(Schema.String)),
          short_description: Schema.optional(Schema.NullOr(Schema.String)),
          display_name: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
);

class MuseSkillsExitError extends Schema.TaggedError<MuseSkillsExitError>()("MuseSkillsExitError", {
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `Muse skill discovery exited with code ${this.exitCode}.`;
  }
}

export const discoverMuseSkills = Effect.fn("discoverMuseSkills")(function* (
  settings: Pick<MuseSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const path = yield* Path.Path;
  const command = settings.binaryPath || "muse";
  const probeEnvironment = makeMuseEnvironment(environment);
  const output = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["skills", "list", "--json", ...(cwd ? ["--workspace", cwd, "--trust-workspace"] : [])],
      { env: probeEnvironment },
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: probeEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS));
  if (output.code !== 0) return yield* new MuseSkillsExitError({ exitCode: output.code });
  const catalog = yield* decodeSkills(output.stdout);
  const home =
    nonEmptyTrimmed(environment.HOME) ??
    nonEmptyTrimmed(environment.USERPROFILE) ??
    (yield* HostProcess.HomeDirectory);
  const skills = new Map<string, ServerProviderSkill>();
  for (const row of catalog.skills) {
    const scope = nonEmptyTrimmed(row.scope);
    const rawName = row.name.trim();
    const name = scope === "plugin" ? rawName.replace(/^plugin:/, "") : rawName;
    let skillPath = row.path.trim();
    const existing = skills.get(name);
    // Muse lists bundled skills alongside their active overrides.
    if (!name || !skillPath || (existing && (existing.scope !== "bundled" || scope === "bundled")))
      continue;
    if (skillPath.startsWith("$HOME/")) skillPath = path.join(home, skillPath.slice(6));
    else if (
      cwd &&
      !skillPath.startsWith("plugin://") &&
      !skillPath.startsWith("bundled://") &&
      !path.isAbsolute(skillPath)
    )
      skillPath = path.join(cwd, skillPath);
    const description = nonEmptyTrimmed(row.description ?? undefined);
    const shortDescription = nonEmptyTrimmed(row.short_description ?? undefined);
    const displayName = nonEmptyTrimmed(row.display_name ?? undefined);
    skills.set(name, {
      name,
      path: skillPath,
      enabled: row.activation !== "off",
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(displayName && displayName !== name ? { displayName } : {}),
      ...(row.activation === "user-invocable-only" ? { userInvocationOnly: true } : {}),
    });
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
});
