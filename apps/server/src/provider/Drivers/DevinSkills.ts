import type { DevinSettings, ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { runDevinCommand } from "../acp/DevinAcpSupport.ts";

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
const decodeCatalog = Schema.decodeEffect(DevinSkillCatalog);
class DevinSkillsError extends Schema.TaggedError<DevinSkillsError>()("DevinSkillsError", {
  message: Schema.String,
}) {}

/** Let the CLI resolve skill roots, overrides, plugins, and invocation policy. */
export const discoverDevinSkills = Effect.fn("discoverDevinSkills")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const path = yield* Path.Path;
  const result = yield* runDevinCommand(settings, environment, ["skills", "list", "--json"], cwd);
  if (result.code !== 0)
    return yield* new DevinSkillsError({ message: "Devin CLI could not list skills." });
  const catalog = yield* decodeCatalog(result.stdout);
  // Built-in CLI commands have no SKILL.md; they belong in the native command menu.
  return catalog
    .filter((skill) => skill.base_dir.length > 0)
    .map((skill): ServerProviderSkill => ({
      name: skill.name,
      path: path.join(skill.base_dir, "SKILL.md"),
      enabled: skill.errors.length === 0,
      userInvocable: skill.triggers.includes("user"),
      userInvocationOnly: !skill.triggers.includes("model"),
      ...(skill.description.trim() ? { description: skill.description.trim() } : {}),
      ...(skill.display_name.trim() ? { displayName: skill.display_name.trim() } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}, Effect.timeout("5 seconds"));

/** ACP expands one leading slash command. Inline mentions do not invoke user-only skills. */
export const prepareDevinSkillPrompt = Effect.fn("prepareDevinSkillPrompt")(function* (
  prompt: string,
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const candidates = collectComposerInlineTokens(`${prompt} `).filter(
    (token) => token.type === "skill",
  );
  if (candidates.length === 0) return prompt;
  const skills = yield* discoverDevinSkills(settings, environment, cwd).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Devin skill discovery failed; sending the original prompt", cause).pipe(
        Effect.as([]),
      ),
    ),
  );
  const names = new Set(
    skills.filter((skill) => skill.enabled && skill.userInvocable).map((skill) => skill.name),
  );
  const mentions = candidates.filter((token) => names.has(token.value));
  if (mentions.length > 1)
    return yield* new DevinSkillsError({
      message: "Devin can invoke one skill per message. Send each skill in a separate message.",
    });
  const mention = mentions[0];
  if (!mention) return prompt;
  const argumentsText = `${prompt.slice(0, mention.start)}${prompt.slice(mention.end)}`.trim();
  return `/${mention.value}${argumentsText ? ` ${argumentsText}` : ""}`;
});
