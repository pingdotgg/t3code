/**
 * PiSkillSettings - Pi's exact exclusions of a skill, read and written for the Skills page.
 *
 * Pi filters the resources it finds with the `skills` array in `<agent dir>/settings.json`: "glob
 * exclusions with `!pattern`, exact inclusion with `+path`, and exact exclusion with `-path`"
 * (https://pi.dev/docs/latest/settings). `addAutoDiscoveredResources` in
 * https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/src/core/package-manager.ts
 * applies the user's array to the skills found in `~/.pi/agent/skills` and `~/.agents/skills`,
 * matching an exact entry against the SKILL.md path or its folder, relative to `~/.agents` or the
 * agent dir (so `skills/<name>/SKILL.md` for both) or absolute. `pi config` writes the relative
 * form (`config-selector.ts`), and a `-` entry beats a `+` one. The agent dir is `~/.pi/agent`
 * unless `PI_CODING_AGENT_DIR` moves it (https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/docs/configuration.md).
 *
 * Only Global skills. A project's skills are filtered by the project's own `.pi/settings.json`,
 * which a team usually commits, so the page leaves a project skill `fixed` instead of editing it.
 * Glob exclusions (`!pattern`) are not evaluated: only the exact entries this page writes are.
 * Pi reads the file with `JSON.parse` (`settings-manager.ts`), so unlike Claude's and OpenCode's
 * it is plain JSON: a file with a comment or a trailing comma is one Pi can't read, and is left
 * alone.
 *
 * @module PiSkillSettings
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { SkillSwitchContext, SkillSwitchView, SwitchedSkill } from "./AgentSkillSettings.ts";
import { editJsoncFile, parseJsonc, readSettingsText, valueAt } from "./JsoncSettings.ts";

const settingsFile = (path: Path.Path, context: SkillSwitchContext) => {
  const moved = context.environment.PI_CODING_AGENT_DIR?.trim() ?? "";
  const agentDir =
    moved === ""
      ? path.join(context.homeDirectory, ".pi", "agent")
      : moved === "~" || moved.startsWith("~/")
        ? path.join(context.homeDirectory, moved.slice(2))
        : path.resolve(context.cwd ?? context.homeDirectory, moved);
  return path.join(agentDir, "settings.json");
};

const normalize = (value: string) => (value.startsWith("./") ? value.slice(2) : value);

/** Every way an exact entry can name this skill: relative to its base folder, or absolute. */
const namesOf = (skill: SwitchedSkill) =>
  new Set(
    [
      `skills/${skill.name}`,
      ...skill.entryPaths.flatMap((entry) => [entry, `${entry}/SKILL.md`]),
      `skills/${skill.name}/SKILL.md`,
    ].map(normalize),
  );

/** The `-` entries of the `skills` array that exclude this skill, with their positions. */
const exclusionsOf = (skills: unknown, skill: SwitchedSkill) => {
  const names = namesOf(skill);
  return (Array.isArray(skills) ? skills : []).flatMap((entry: unknown, index) =>
    typeof entry === "string" && entry.startsWith("-") && names.has(normalize(entry.slice(1)))
      ? [index]
      : [],
  );
};

const isValidSettings = (value: Record<string, unknown>) =>
  value.skills === undefined ||
  (Array.isArray(value.skills) && value.skills.every((entry) => typeof entry === "string"));

export const piSwitches = (context: SkillSwitchContext) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const text = yield* readSettingsText(settingsFile(path, context));
    const parsed = text === undefined ? undefined : parseJsonc(text, true);
    const skills = parsed?.valid ? valueAt(parsed.value, ["skills"]) : undefined;
    return {
      off: (skill: SwitchedSkill) =>
        skill.scope === "global" && exclusionsOf(skills, skill).length > 0,
    } satisfies SkillSwitchView;
  });

export const setPiSwitch = Effect.fn("setPiSwitch")(function* (
  context: SkillSwitchContext,
  skill: SwitchedSkill,
  off: boolean,
) {
  if (skill.scope !== "global") return "failed" as const;
  const file = settingsFile(yield* Path.Path, context);
  const text = yield* readSettingsText(file);
  const parsed = text === undefined ? undefined : parseJsonc(text, true);
  if (parsed !== undefined && !parsed.valid) return "failed" as const;
  const positions = exclusionsOf(valueAt(parsed?.value, ["skills"]), skill);

  const changes = off
    ? positions.length > 0
      ? []
      : [{ path: ["skills"], value: `-skills/${skill.name}/SKILL.md`, insert: true }]
    : // Last first, so the positions still mean what they did.
      positions.toReversed().map((index) => ({ path: ["skills", index], value: undefined }));
  if (changes.length === 0) return "unchanged" as const;

  const result = yield* editJsoncFile({ file, changes, accept: isValidSettings, strict: true });
  return result === "invalid" ? ("failed" as const) : result;
});
