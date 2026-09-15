import type { ModelSelection, ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import * as AcpErrors from "effect-acp/errors";

import { spawnAndCollect } from "../providerSnapshot.ts";
import type { AcpSpawnInput, AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import { DevinModelCatalog, resolveDevinModel } from "./DevinModels.ts";

export const DEVIN_MODEL_OPTION_IDS = ["reasoningEffort", "fastMode", "contextWindow"];

/** Registry resolution owns the executable and environment, including managed installs. */
const runDevinCommand = Effect.fn("DevinCli.runCommand")(function* (
  spawn: AcpSpawnInput,
  args: ReadonlyArray<string>,
) {
  const resolved = yield* resolveSpawnCommand(spawn.command, args, { env: spawn.env ?? {} });
  const result = yield* spawnAndCollect(
    spawn.command,
    ChildProcess.make(resolved.command, resolved.args, {
      cwd: spawn.cwd,
      env: spawn.env,
      extendEnv: spawn.extendEnv,
      shell: resolved.shell,
    }),
  );
  if (result.code !== 0) {
    return yield* AcpErrors.AcpRequestError.internalError(
      `Devin CLI could not run ${args.join(" ")}. Check this provider instance's sign-in.`,
    );
  }
  return result.stdout;
}, Effect.timeout("10 seconds"));

/** Unlike ACP's initial disk cache, this command waits for the account's current catalog. */
export const readDevinModelCatalog = (spawn: AcpSpawnInput) =>
  runDevinCommand(spawn, ["models", "list", "--format", "json"]).pipe(
    Effect.flatMap(Schema.decodeEffect(DevinModelCatalog)),
  );

export const applyDevinModelSelection = Effect.fn("DevinCli.applyModelSelection")(
  function* (
    spawn: AcpSpawnInput,
    runtime: Pick<AcpSessionRuntime["Service"], "setModel">,
    selection: ModelSelection,
  ) {
    if (selection.model === "default" || selection.model === "auto") return undefined;
    const catalog = yield* readDevinModelCatalog(spawn);
    const model = resolveDevinModel(catalog, selection);
    if (model === undefined) {
      return yield* AcpErrors.AcpRequestError.invalidParams(
        "This Devin model and option combination is unavailable. Choose an available model or change its options.",
      );
    }
    yield* runtime.setModel(model);
    return model;
  },
  Effect.mapError((cause) => AcpErrors.AcpRequestError.invalidParams(cause.message)),
);

export const DevinSkillCatalog = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      description: Schema.String,
      base_dir: Schema.String,
      display_name: Schema.String,
      triggers: Schema.Array(Schema.String),
      errors: Schema.Array(Schema.Unknown),
    }),
  ),
);

/** The CLI resolves workspace roots, overrides, plugins, and invocation policy. */
export const discoverDevinSkills = Effect.fn("DevinCli.discoverSkills")(function* (
  spawn: AcpSpawnInput,
) {
  const path = yield* Path.Path;
  return yield* runDevinCommand(spawn, ["skills", "list", "--json"]).pipe(
    Effect.flatMap(Schema.decodeEffect(DevinSkillCatalog)),
    Effect.map((skills) =>
      skills
        // Built-in CLI commands have no SKILL.md and belong in the slash-command menu.
        .filter((skill) => skill.base_dir.length > 0)
        .map((skill): ServerProviderSkill => {
          let entry: ServerProviderSkill = {
            name: path.basename(skill.base_dir),
            path: path.join(skill.base_dir, "SKILL.md"),
            enabled: skill.errors.length === 0,
            userInvocable: skill.triggers.includes("user"),
            userInvocationOnly: !skill.triggers.includes("model"),
          };
          if (skill.description.trim()) entry = { ...entry, description: skill.description.trim() };
          if (skill.display_name.trim())
            entry = { ...entry, displayName: skill.display_name.trim() };
          return entry;
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  );
});

/** ACP expands one leading slash command, including user-only workspace skills. */
export function devinSkillPrompt(prompt: string, skills: ReadonlyArray<ServerProviderSkill>) {
  const names = new Set(
    skills.filter((skill) => skill.enabled && skill.userInvocable).map((skill) => skill.name),
  );
  const mentions = collectComposerInlineTokens(`${prompt} `).filter(
    (token) => token.type === "skill" && names.has(token.value),
  );
  if (mentions.length > 1) {
    return Effect.fail(
      AcpErrors.AcpRequestError.invalidParams(
        "Devin can invoke one skill per message. Send each skill in a separate message.",
      ),
    );
  }
  const mention = mentions[0];
  if (!mention) return Effect.succeed(prompt);
  const argumentsText = `${prompt.slice(0, mention.start)}${prompt.slice(mention.end)}`.trim();
  return Effect.succeed(`/${mention.value}${argumentsText ? ` ${argumentsText}` : ""}`);
}

export const prepareDevinSkillPrompt = Effect.fn("DevinCli.prepareSkillPrompt")(function* (
  prompt: string,
  spawn: AcpSpawnInput,
) {
  if (!collectComposerInlineTokens(`${prompt} `).some((token) => token.type === "skill")) {
    return prompt;
  }
  const skills = yield* discoverDevinSkills(spawn).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Devin skill discovery failed", cause).pipe(Effect.as([])),
    ),
  );
  return yield* devinSkillPrompt(prompt, skills);
});
