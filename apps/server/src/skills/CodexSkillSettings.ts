/**
 * CodexSkillSettings - which skills Codex's own config switches off, and what to ask Codex to
 * write to change that.
 *
 * Codex keeps this in `$CODEX_HOME/config.toml` as `[[skills.config]]` tables, each naming a skill
 * by `path` (its SKILL.md) or by `name` and carrying `enabled`. Reading is a plain file read with
 * `smol-toml`, so listing never starts Codex. Writing is Codex's: `skills/config/write` through
 * the app-server (`ProviderInstance.openSkillSettingsWriter`, see `CodexProvider.ts`), which owns the file's format.
 *
 * Checked against codex 0.160.1 with a throwaway `CODEX_HOME`:
 * - Codex canonicalizes a path on write and on load, so a skill reached through a link is
 *   recorded (and matched) by the real path of its SKILL.md, and `~` and paths relative to the
 *   config's folder are honoured. A path naming the skill's folder instead of SKILL.md is not.
 * - `enabled: true` removes the matching entry, and does nothing when there is none.
 * - A name entry is matched against the skill's `name` header (its folder name when it has none)
 *   and is cleared only by writing the name, not the path.
 * - The write's `effectiveEnabled` answers for the path alone, so it can't see a name entry; the
 *   file is read again to tell what is decided now.
 * - Entries apply in file order and the last one that names the skill wins.
 * - A project's `.codex/config.toml` is not read: its skill rules did not apply in an untrusted
 *   project, and the page keeps to the user's own file.
 *
 * An instance with a shadow home (`shadowHomePath`) runs Codex there, so the app-server writes
 * the shadow home's `config.toml` and that is the file to read back (`codexSettingsHome`). The
 * shadow home links the shared home's `config.toml` only when it existed as the instance started;
 * without one the write lands in a file of the shadow home's own.
 *
 * @module CodexSkillSettings
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";
import type { SkillSettingsChange } from "@t3tools/provider-core/server/driver";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { SkillSwitchContext, SkillSwitchView, SwitchedSkill } from "./AgentSkillSettings.ts";

/** One `[[skills.config]]` table, its path made absolute and real. */
export interface CodexSkillRule {
  readonly selector: { readonly path: string } | { readonly name: string };
  readonly enabled: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeShadowHome = Schema.decodeUnknownOption(
  Schema.Struct({ shadowHomePath: Schema.optional(Schema.String) }),
);

/**
 * The home an instance's Codex runs with, whose `config.toml` its app-server writes: the shadow
 * home when the instance has one, else its home (`sharedHome`). The driver's own layout makes
 * the same choice (`resolveCodexHomeLayout`); the skill folders stay where `sharedHome` says,
 * since the shadow home links the shared `skills` folder.
 */
export const codexSettingsHome = (
  path: Path.Path,
  instanceConfig: unknown,
  sharedHome: string,
  homeDirectory: string,
) => {
  const shadow =
    Option.getOrUndefined(decodeShadowHome(instanceConfig))?.shadowHomePath?.trim() ?? "";
  return shadow === "" ? sharedHome : path.resolve(expandHomePath(shadow, homeDirectory));
};

/** The rules in the user's config, in file order; none when it is missing or can't be parsed. */
export const readCodexSkillRules = (context: SkillSwitchContext) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem
      .readFileString(path.join(context.configHome, "config.toml"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) return [];
    const document = yield* Effect.try(() => parseToml(text)).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("codex config is unreadable; no skill rules", { cause }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const entries = isRecord(document?.skills) ? document.skills.config : undefined;
    if (!Array.isArray(entries)) return [];

    return yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        if (!isRecord(entry) || typeof entry.enabled !== "boolean") return [];
        if (typeof entry.name === "string" && entry.path === undefined) {
          return [
            { selector: { name: entry.name }, enabled: entry.enabled } satisfies CodexSkillRule,
          ];
        }
        if (typeof entry.path !== "string" || entry.name !== undefined) return [];
        const expanded = entry.path.startsWith("~/")
          ? path.join(context.homeDirectory, entry.path.slice(2))
          : entry.path === "~"
            ? context.homeDirectory
            : entry.path;
        const absolute = path.resolve(context.configHome, expanded);
        const real = yield* fileSystem
          .realPath(absolute)
          .pipe(Effect.orElseSucceed(() => absolute));
        return [{ selector: { path: real }, enabled: entry.enabled } satisfies CodexSkillRule];
      }),
    ).pipe(Effect.map((rules) => rules.flat()));
  });

/** The path Codex records for a skill: its SKILL.md, where the skill's real folder is. */
export const codexSkillFile = (path: Path.Path, skill: SwitchedSkill) =>
  path.join(skill.home, "SKILL.md");

const names = (skill: SwitchedSkill) => new Set([skill.declaredName ?? skill.name]);

const namesSkill = (rule: CodexSkillRule, file: string, skill: SwitchedSkill) =>
  "path" in rule.selector ? rule.selector.path === file : names(skill).has(rule.selector.name);

/** Whether the rules leave the skill off: the last rule that names it says so. */
export const codexRulesSwitchOff = (
  rules: ReadonlyArray<CodexSkillRule>,
  file: string,
  skill: SwitchedSkill,
) => rules.findLast((rule) => namesSkill(rule, file, skill))?.enabled === false;

export const codexSwitches = (context: SkillSwitchContext) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const rules = yield* readCodexSkillRules(context);
    return {
      off: (skill: SwitchedSkill) => codexRulesSwitchOff(rules, codexSkillFile(path, skill), skill),
    } satisfies SkillSwitchView;
  });

/**
 * The writes that make the skill off (or no longer off) given the rules now: none when it is
 * already so. Turning on clears every kind of entry that names the skill, since Codex removes an
 * entry only by the selector it was written with.
 */
export const planCodexSwitch = (
  rules: ReadonlyArray<CodexSkillRule>,
  file: string,
  skill: SwitchedSkill,
  off: boolean,
): ReadonlyArray<SkillSettingsChange> => {
  if (codexRulesSwitchOff(rules, file, skill) === off) return [];
  if (off) return [{ path: file, enabled: false }];
  const matching = rules.filter((rule) => namesSkill(rule, file, skill));
  return [
    ...(matching.some((rule) => "path" in rule.selector)
      ? [{ path: file, enabled: true } satisfies SkillSettingsChange]
      : []),
    ...[
      ...new Set(matching.flatMap((rule) => ("name" in rule.selector ? [rule.selector.name] : []))),
    ].map((name) => ({ name, enabled: true }) satisfies SkillSettingsChange),
  ];
};
