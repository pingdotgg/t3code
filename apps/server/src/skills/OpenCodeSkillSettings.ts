/**
 * OpenCodeSkillSettings - OpenCode's `permission.skill` rules, read and written for the Skills
 * page.
 *
 * `"permission": { "skill": { "<name>": "deny" } }` hides a skill from the agent
 * (https://opencode.ai/docs/skills), where `<name>` is the `name` in the skill's header, not its
 * folder's (`state.skills[md.data.name]` in `skill/index.ts`). Rules are evaluated with `findLast`, the last rule whose
 * pattern matches the name deciding, over the rules of every config layer in order
 * (`evaluate` in `permission/index.ts` at
 * https://github.com/anomalyco/opencode/blob/4ac0d9c3d1/packages/opencode/src/permission/index.ts);
 * a pattern can use `*` and `?`. The layers, lowest first, as `config/config.ts` merges them:
 * the global folder (`config.json`, `opencode.json`, `opencode.jsonc`), the project's
 * `opencode.json[c]` and `.opencode/opencode.json[c]`, then the managed folder. Only the project's
 * own folder is looked in, not the folders above it. `skill` can also be one action for every
 * skill (`"skill": "deny"`), which reads as a `*` rule.
 *
 * A write goes to the global config (`opencode.jsonc` when there is one, else `opencode.json`),
 * at the end of its rules so it is the last one to match. What the rules would add up to is
 * worked out first, so a project or managed rule that keeps the skill the way it is makes this
 * `setElsewhere` and writes nothing. Turning a skill on deletes the key; when a wildcard rule
 * would still deny it, an `allow` is written in its place.
 *
 * @module OpenCodeSkillSettings
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { SkillSwitchContext, SkillSwitchView, SwitchedSkill } from "./AgentSkillSettings.ts";
import {
  editJsoncFile,
  parseJsonc,
  readSettingsText,
  valueAt,
  type JsoncChange,
} from "./JsoncSettings.ts";

interface Rule {
  readonly pattern: string;
  readonly action: string;
}

interface Layer {
  readonly file: string;
  readonly global: boolean;
  readonly exists: boolean;
  readonly rules: ReadonlyArray<Rule>;
}

const escapeRegExp = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const matches = (pattern: string, name: string) =>
  new RegExp(`^${escapeRegExp(pattern).replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(name);

/** What the rules decide for a name: the action of the last one that matches, else none. */
const actionFor = (layers: ReadonlyArray<Pick<Layer, "rules">>, name: string) =>
  layers.flatMap((layer) => layer.rules).findLast((rule) => matches(rule.pattern, name))?.action;

const isOff = (layers: ReadonlyArray<Pick<Layer, "rules">>, name: string) =>
  actionFor(layers, name) === "deny";

const rulesOf = (config: unknown): ReadonlyArray<Rule> => {
  const skill = valueAt(config, ["permission", "skill"]);
  if (typeof skill === "string") return [{ pattern: "*", action: skill }];
  if (typeof skill !== "object" || skill === null || Array.isArray(skill)) return [];
  return Object.entries(skill).flatMap(([pattern, action]) =>
    typeof action === "string" ? [{ pattern, action }] : [],
  );
};

const managedFolder = (path: Path.Path, context: SkillSwitchContext, platform: NodeJS.Platform) => {
  const override = context.environment.OPENCODE_TEST_MANAGED_CONFIG_DIR?.trim();
  if (override) return override;
  if (platform === "darwin") return "/Library/Application Support/opencode";
  if (platform === "win32") {
    return path.join(context.environment.ProgramData?.trim() || "C:\\ProgramData", "opencode");
  }
  return "/etc/opencode";
};

const readLayers = Effect.fnUntraced(function* (context: SkillSwitchContext) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const xdg = context.environment.XDG_CONFIG_HOME?.trim();
  const globalFolder = path.join(
    xdg && path.isAbsolute(xdg) ? xdg : path.join(context.homeDirectory, ".config"),
    "opencode",
  );
  const files = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((name) => ({
      file: path.join(globalFolder, name),
      global: true,
    })),
    ...(context.cwd === undefined
      ? []
      : [
          ...["opencode.json", "opencode.jsonc"].map((name) => ({
            file: path.join(context.cwd as string, name),
            global: false,
          })),
          ...["opencode.json", "opencode.jsonc"].map((name) => ({
            file: path.join(context.cwd as string, ".opencode", name),
            global: false,
          })),
        ]),
    ...["opencode.json", "opencode.jsonc"].map((name) => ({
      file: path.join(managedFolder(path, context, platform), name),
      global: false,
    })),
  ];
  return yield* Effect.forEach(files, ({ file, global }) =>
    readSettingsText(file).pipe(
      Effect.map((text): Layer => {
        const parsed = text === undefined ? undefined : parseJsonc(text);
        return {
          file,
          global,
          exists: text !== undefined,
          rules: parsed?.valid ? rulesOf(parsed.value) : [],
        };
      }),
    ),
  );
});

/** What OpenCode calls the skill: its header's name, else the folder's. */
const nameOf = (skill: SwitchedSkill) => skill.declaredName ?? skill.name;

export const openCodeSwitches = (context: SkillSwitchContext) =>
  Effect.gen(function* () {
    const layers = yield* readLayers(context);
    return {
      off: (skill: SwitchedSkill) => isOff(layers, nameOf(skill)),
    } satisfies SkillSwitchView;
  });

export const setOpenCodeSwitch = Effect.fn("setOpenCodeSwitch")(function* (
  context: SkillSwitchContext,
  skill: SwitchedSkill,
  off: boolean,
) {
  const path = yield* Path.Path;
  const name = nameOf(skill);
  // A name with a wildcard in it would be a rule for other skills too.
  if (/[*?]/.test(name)) return "failed" as const;
  const layers = yield* readLayers(context);
  if (isOff(layers, name) === off) return "unchanged" as const;

  // The global file that wins over the other global files: where a new rule goes. `config.json`
  // is the legacy name and is never created.
  const globals = layers.filter((layer) => layer.global);
  const target =
    globals.findLast((layer) => layer.exists && path.basename(layer.file) !== "config.json") ??
    globals.find((layer) => path.basename(layer.file) === "opencode.json");
  if (target === undefined) return "failed" as const;

  const withoutKey = (layer: Layer): Layer => ({
    ...layer,
    rules: layer.rules.filter((rule) => rule.pattern !== name),
  });
  const withRule = (action: "deny" | "allow") =>
    layers.map((layer) =>
      layer === target
        ? { ...layer, rules: [...withoutKey(layer).rules, { pattern: name, action }] }
        : layer.global
          ? withoutKey(layer)
          : layer,
    );

  // What each global file has to say about the key, to produce the plan, then check its result.
  const key = ["permission", "skill", name] as const;
  const plans = new Map<string, JsoncChange[]>();
  const plan = (layer: Layer, ...changes: JsoncChange[]) =>
    plans.set(layer.file, [...(plans.get(layer.file) ?? []), ...changes]);
  const asObject = Effect.fnUntraced(function* (layer: Layer) {
    // `"skill": "deny"` becomes `{ "*": "deny" }` before a key is added next to it.
    const text = yield* readSettingsText(layer.file);
    const action =
      text === undefined ? undefined : valueAt(parseJsonc(text).value, ["permission", "skill"]);
    if (typeof action === "string")
      plan(layer, { path: ["permission", "skill"], value: { "*": action } });
  });

  if (off) {
    if (!isOff(withRule("deny"), name)) return "setElsewhere" as const;
    yield* asObject(target);
    plan(target, { path: key, value: undefined }, { path: key, value: "deny" });
  } else {
    // Deleting the key may be enough; a wildcard rule that still denies needs an `allow` after it.
    const needsAllow = isOff(
      layers.map((layer) => (layer.global ? withoutKey(layer) : layer)),
      name,
    );
    if (needsAllow && isOff(withRule("allow"), name)) return "setElsewhere" as const;
    for (const layer of globals) {
      if (layer.rules.some((rule) => rule.pattern === name))
        plan(layer, { path: key, value: undefined });
    }
    if (needsAllow) {
      yield* asObject(target);
      plan(target, { path: key, value: "allow" });
    }
  }

  const results = yield* Effect.forEach([...plans], ([file, changes]) =>
    editJsoncFile({ file, changes }),
  );
  if (results.some((result) => result === "invalid" || result === "failed"))
    return "failed" as const;
  return results.some((result) => result === "written")
    ? ("written" as const)
    : ("unchanged" as const);
});
