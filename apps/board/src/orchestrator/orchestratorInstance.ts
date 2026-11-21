import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import adapter from "../../pstack/pstack-t3.md?raw";
import potetoMode from "../../pstack/poteto-mode.md?raw";

const PREFIX = "board-orchestrator-";
const AGENTS_PREFIX = "board-agents-";

/** The engine's provider instance that carries the standing rules for orchestrators on `baseId`'s account. */
export const orchestratorInstanceId = (baseId: string) => `${PREFIX}${baseId}`;

/** The engine's provider instance the children of those orchestrators run on. */
export const agentsInstanceId = (baseId: string) => `${AGENTS_PREFIX}${baseId}`;

export const isOrchestratorInstance = (instanceId: string) => instanceId.startsWith(PREFIX);

/** An instance the board made and the user never picks. */
export const isBoardInstance = (instanceId: string) =>
  isOrchestratorInstance(instanceId) || instanceId.startsWith(AGENTS_PREFIX);

/** The instance an orchestrator instance copies, which is the one the user picks. */
export const baseInstanceId = (instanceId: string) =>
  isOrchestratorInstance(instanceId) ? instanceId.slice(PREFIX.length) : instanceId;

/**
 * Everything an orchestrator is told once and keeps through compaction: poteto-mode, the adapter
 * that maps it onto T3's tools, then the board's rules, which win where they differ. The two
 * skills are copies from the `pstack-t3` repo, refreshed with `scripts/vendor-pstack.mjs`.
 */
export const standingInstructions = (rules: string) =>
  `${potetoMode.trimEnd()}\n\n${adapter.trimEnd()}\n\n${rules}`;

// T3 splits launch arguments like a shell does, so a double-quoted token holds any text once `\`, `"`, `$`, and backtick are escaped.
const quote = (text: string) => `"${text.replace(/[\\"$`]/g, "\\$&")}"`;

// T3 runs its three tracker write tools with no approval in any runtime mode. An ask rule on the
// instance makes each wait as an engine approval, and covers every ticket worktree with nothing
// written into the repository.
const claudeTrackerArgs = `--settings ${quote(
  JSON.stringify({
    permissions: {
      ask: ["create_issue", "comment_on_issue", "set_issue_state"].map(
        (tool) => `mcp__t3-code__${tool}`,
      ),
    },
  }),
)}`;

/**
 * The launch arguments that give a session standing instructions the provider re-sends after every
 * compaction. Claude Code also loses its built-in subagent tool, whose children T3 creates outside the registry.
 */
const standingArgs = (instructions: string) =>
  `--append-system-prompt ${quote(instructions)} --disallowedTools ${quote("Task,Agent")} ${claudeTrackerArgs}`;

export interface OrchestratorInstancePlan {
  readonly instanceId: string;
  /** Null when the instance already has these rules, so nothing is written. */
  readonly mutation: ProviderInstanceMutation | null;
}

const instanceAt = (
  providerInstances: ServerSettings["providerInstances"],
  instanceId: string,
): ProviderInstanceConfig | undefined =>
  Object.hasOwn(providerInstances, instanceId)
    ? providerInstances[ProviderInstanceId.make(instanceId)]
    : undefined;

const InstanceConfig = Schema.StructWithRest(
  Schema.Struct({ launchArgs: Schema.optional(Schema.String) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const decodeConfig = Schema.decodeUnknownOption(InstanceConfig);

const configOf = (instance: ProviderInstanceConfig | undefined) =>
  Option.getOrThrowWith(
    decodeConfig(instance?.config ?? {}),
    () => new Error("The instance's config could not be read, so it cannot be copied."),
  );

const PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS";

/**
 * Claude Code loads a plugin folder named in CLAUDE_CODE_PLUGIN_DIRS for that session only, so
 * pstack-t3 reaches the board's instances and no other Claude Code session.
 */
function withPluginDir(
  environment: ProviderInstanceConfig["environment"],
  pluginDir: string,
): NonNullable<ProviderInstanceConfig["environment"]> {
  return [
    ...(environment ?? []).filter((entry) => entry.name !== PLUGIN_DIRS),
    { name: PLUGIN_DIRS, value: pluginDir, sensitive: false },
  ];
}

/**
 * Copies the picked instance's binary, home, environment, and launch arguments into one board
 * instance, with `extraArgs` after them, and loads the pstack-t3 folder. The write
 * is an upsert, so two boards that start together cannot fail on each other's create.
 */
function planCopy(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly base: { readonly instanceId: string; readonly driver: string };
  readonly instanceId: string;
  readonly label: string;
  readonly extraArgs: string;
  readonly pluginDir: string;
}): OrchestratorInstancePlan {
  const { providerInstances, base, instanceId } = input;
  const source = instanceAt(providerInstances, base.instanceId);
  const sourceConfig = configOf(source);
  // shortcut: a base instance's own --settings is replaced by the board's ask rule, upgrade when T3 merges settings files
  const own = sourceConfig.launchArgs?.trim() ?? "";
  const launchArgs = [own, input.extraArgs].filter((part) => part !== "").join(" ");
  const environment = withPluginDir(source?.environment, input.pluginDir);

  const existing = instanceAt(providerInstances, instanceId);
  if (
    existing?.enabled !== false &&
    (configOf(existing).launchArgs ?? "") === launchArgs &&
    JSON.stringify(existing?.environment ?? []) === JSON.stringify(environment ?? [])
  ) {
    return { instanceId, mutation: null };
  }
  const instance: ProviderInstanceConfig = {
    ...source,
    driver: ProviderDriverKind.make(base.driver),
    displayName: `${source?.displayName ?? base.instanceId} (${input.label})`,
    enabled: true,
    config: { ...sourceConfig, ...(launchArgs === "" ? {} : { launchArgs }) },
    ...(environment === undefined ? {} : { environment }),
  };
  return {
    instanceId,
    mutation: { operation: "upsert", instanceId: ProviderInstanceId.make(instanceId), instance },
  };
}

/** The orchestrator's instance: the picked one plus the standing instructions. */
export function planOrchestratorInstance(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly base: { readonly instanceId: string; readonly driver: string };
  readonly rules: string;
  readonly pluginDir: string;
}): OrchestratorInstancePlan {
  const args = standingArgs(standingInstructions(input.rules));
  return planCopy({
    ...input,
    instanceId: orchestratorInstanceId(input.base.instanceId),
    label: "board orchestrator",
    extraArgs: args,
  });
}

/** The instance every child runs on: the pstack-t3 skills, and never the orchestrator's rules. */
export function planAgentsInstance(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly base: { readonly instanceId: string; readonly driver: string };
  readonly pluginDir: string;
}): OrchestratorInstancePlan {
  return planCopy({
    ...input,
    instanceId: agentsInstanceId(input.base.instanceId),
    label: "board agents",
    extraArgs: claudeTrackerArgs,
  });
}
