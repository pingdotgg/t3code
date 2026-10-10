/**
 * AgentConfigHome - where a provider instance keeps its config, which its own skill and
 * instruction folders live under.
 *
 * This follows the setting or variable that moves the agent's home, in the order the agent applies
 * them: Claude's `homePath` setting, then `CLAUDE_CONFIG_DIR`; Codex's `homePath`, then
 * `CODEX_HOME`; Grok's `GROK_HOME`. Anything else stays at the default folder.
 *
 * This is where the agent's own folders are, not always where it reads its settings from: a Codex
 * instance with a shadow home runs in that home, and `codexSettingsHome` says so for the settings
 * file the skill switches read and write.
 *
 * @module AgentConfigHome
 */
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { resolveClaudeConfigDirPath } from "../provider/Drivers/ClaudeSkills.ts";

const decodeHomePath = Schema.decodeUnknownOption(
  Schema.Struct({ homePath: Schema.optional(Schema.String) }),
);

/** The instance's `homePath` setting, trimmed; empty when it has none. */
const instanceHomePath = (instance: ProviderInstanceConfig) =>
  Option.getOrUndefined(decodeHomePath(instance.config))?.homePath?.trim() ?? "";

export const resolveAgentConfigHome = Effect.fnUntraced(function* (input: {
  readonly instance: ProviderInstanceConfig;
  /** The agent's default folder, used when nothing moves it. */
  readonly fallback: string;
  /** The server process's environment; the instance's own variables are laid over it. */
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const { instance, fallback, cwd } = input;
  const env = yield* mergeProviderInstanceEnvironment(instance.environment, input.environment);
  const setting = instanceHomePath(instance);
  const absoluteOr = (value: string | undefined) =>
    value && path.isAbsolute(value) ? value : fallback;
  if (instance.driver === "claudeAgent") {
    return yield* resolveClaudeConfigDirPath({ homePath: setting }, env, cwd);
  }
  if (instance.driver === "codex") {
    return absoluteOr(expandHomePath(setting || (env.CODEX_HOME?.trim() ?? ""), home));
  }
  if (instance.driver === "grok") return absoluteOr(env.GROK_HOME?.trim());
  return fallback;
});
