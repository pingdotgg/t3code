/**
 * ClaudeSkillSettings - Claude Code's `skillOverrides`, read and written for the Skills page.
 *
 * The layers, their order and the CLI's whole-map validation are `ClaudeSkills.ts`'s (verified
 * against the CLI there); this reads them with the same reader the `$` picker uses. A skill is off
 * when the last layer that names it says `"off"`.
 *
 * A write goes to the layer that fits the skill: a Global skill to the user's `settings.json`, a
 * project skill to the project's `.claude/settings.local.json` (just the user; the page never
 * edits a file a team shares). What the result would be is worked out first, over every layer, so
 * a layer above the one written (a project's local file over the user's, or the managed policy)
 * that keeps the skill the way it is makes this `setElsewhere` and writes nothing. Turning a skill
 * on removes the key; `"on"` is written only when a layer below the target still says off. When
 * the project's local file is created here, it is kept out of git as Claude Code does when it
 * creates the file (`excludeNewFile`).
 *
 * @module ClaudeSkillSettings
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  readSkillOverrideLayers,
  SkillOverrideValue,
  type SkillOverrideLayer,
} from "../provider/Drivers/ClaudeSkills.ts";
import type { SkillSwitchContext, SkillSwitchView, SwitchedSkill } from "./AgentSkillSettings.ts";
import { editJsoncFile } from "./JsoncSettings.ts";
import { excludeNewFile } from "./SkillGitExclude.ts";

type OverrideValue = typeof SkillOverrideValue.Type;

const isValidSettings = Schema.is(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);

/** What the layers add up to for one skill, with `target` holding `replacement` instead. */
const outcome = (
  layers: ReadonlyArray<SkillOverrideLayer>,
  name: string,
  target?: { readonly index: number; readonly replacement: OverrideValue | undefined },
) => {
  let decided: { readonly index: number; readonly value: OverrideValue } | undefined;
  layers.forEach((layer, index) => {
    const value = target?.index === index ? target.replacement : layer.overrides?.get(name);
    if (value !== undefined) decided = { index, value };
  });
  return decided;
};

export const claudeSwitches = (context: SkillSwitchContext) =>
  Effect.gen(function* () {
    const layers = yield* readSkillOverrideLayers(
      context.configHome,
      context.cwd,
      context.environment,
    );
    return {
      off: (skill: SwitchedSkill) => outcome(layers, skill.name)?.value === "off",
    } satisfies SkillSwitchView;
  });

export const setClaudeSwitch = Effect.fn("setClaudeSwitch")(function* (
  context: SkillSwitchContext,
  skill: SwitchedSkill,
  off: boolean,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const targetPath =
    skill.scope === "global"
      ? path.join(context.configHome, "settings.json")
      : context.cwd === undefined
        ? undefined
        : path.join(context.cwd, ".claude", "settings.local.json");
  const layers = yield* readSkillOverrideLayers(
    context.configHome,
    context.cwd,
    context.environment,
  );
  const index = layers.findIndex((layer) => layer.path === targetPath);
  if (targetPath === undefined || index < 0) return "failed" as const;

  const current = layers[index]?.overrides?.get(skill.name);
  // Only a project's local file is kept out of git, and only when this write is what makes it.
  const existed = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => true));
  const edit = Effect.fnUntraced(function* (value: OverrideValue | undefined) {
    const result = yield* editJsoncFile({
      file: targetPath,
      changes: [{ path: ["skillOverrides", skill.name], value }],
      accept: isValidSettings,
    });
    if (result === "written" && !existed && skill.scope === "project" && context.cwd) {
      // The file works either way; it would only show up in git status.
      yield* excludeNewFile({ projectRoot: context.cwd, file: targetPath }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("could not keep Claude's local settings out of git", {
                file: targetPath,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
    return result === "invalid" ? ("failed" as const) : result;
  });

  if (off) {
    if (outcome(layers, skill.name, { index, replacement: "off" })?.value !== "off") {
      return "setElsewhere" as const;
    }
    return current === "off" ? ("unchanged" as const) : yield* edit("off");
  }

  const without = outcome(layers, skill.name, { index, replacement: undefined });
  if (without?.value !== "off") {
    return current === undefined ? ("unchanged" as const) : yield* edit(undefined);
  }
  // A layer is still switching it off: one below the target is overridden with an explicit "on";
  // one above is out of reach.
  if (without.index > index) return "setElsewhere" as const;
  return current === "on" ? ("unchanged" as const) : yield* edit("on");
});
