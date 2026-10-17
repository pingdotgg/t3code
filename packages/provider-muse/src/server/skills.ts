// @effect-diagnostics-next-line nodeBuiltinImport:off -- The synchronous parser only uses pure path operations, with no filesystem access.
import * as NodePath from "node:path";
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { MuseSettings } from "../settings.ts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { makeMuseEnvironment } from "./sdk.ts";

class MuseSkillsProbeError extends Schema.TaggedError<MuseSkillsProbeError>()(
  "MuseSkillsProbeError",
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
    return `\`muse skills list --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

export function parseMuseSkillsList(
  stdout: string,
  { cwd, home }: { readonly cwd?: string; readonly home: string },
): ServerProviderSkill[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) return undefined;

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const scope = typeof row.scope === "string" ? row.scope.trim() : "";
    const rawName = typeof row.name === "string" ? row.name.trim() : "";
    const name = scope === "plugin" ? rawName.replace(/^plugin:/, "") : rawName;
    let path = typeof row.path === "string" ? row.path.trim() : "";
    if (!name || !path || skillsByName.has(name)) continue;
    if (path.startsWith("$HOME/")) path = NodePath.join(home, path.slice(6));
    else if (
      cwd &&
      !path.startsWith("plugin://") &&
      !path.startsWith("bundled://") &&
      !NodePath.isAbsolute(path)
    )
      path = NodePath.join(cwd, path);
    const description = typeof row.description === "string" ? row.description.trim() : "";
    const shortDescription =
      typeof row.short_description === "string" ? row.short_description.trim() : "";
    const displayName = typeof row.display_name === "string" ? row.display_name.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: row.activation !== "off",
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(displayName && displayName !== name ? { displayName } : {}),
      ...(row.activation === "user-invocable-only" ? { userInvocationOnly: true } : {}),
    });
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export const discoverMuseSkills = Effect.fn("discoverMuseSkills")(function* (
  settings: Pick<MuseSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = settings.binaryPath || "muse";
  const probeEnvironment = makeMuseEnvironment(environment);
  const result = yield* Effect.gen(function* () {
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
  }).pipe(
    Effect.mapError(
      (cause) => new MuseSkillsProbeError({ stage: "spawn", ...(cwd ? { cwd } : {}), cause }),
    ),
    Effect.timeoutOption(4_000),
  );
  if (Option.isNone(result))
    return yield* new MuseSkillsProbeError({ stage: "timeout", ...(cwd ? { cwd } : {}) });
  const output = result.value;
  if (output.code !== 0)
    return yield* new MuseSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const skills = parseMuseSkillsList(output.stdout, { ...(cwd ? { cwd } : {}), home });
  if (!skills) return yield* new MuseSkillsProbeError({ stage: "decode", ...(cwd ? { cwd } : {}) });
  return skills;
});

export function museSkillSelectorsInPrompt(text: string, selectors: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      [...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
        const selector = match[2];
        return selector && selectors.has(selector) ? [selector] : [];
      }),
    ),
  ];
}
