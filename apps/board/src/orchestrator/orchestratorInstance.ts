import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const PREFIX = "board-orchestrator-";

/** The engine's provider instance that carries the standing rules for orchestrators on `baseId`'s account. */
export const orchestratorInstanceId = (baseId: string) => `${PREFIX}${baseId}`;

export const isOrchestratorInstance = (instanceId: string) => instanceId.startsWith(PREFIX);

/** The instance an orchestrator instance copies, which is the one the user picks. */
export const baseInstanceId = (instanceId: string) =>
  isOrchestratorInstance(instanceId) ? instanceId.slice(PREFIX.length) : instanceId;

// T3 splits launch arguments like a shell does, so a double-quoted token holds any text once `\`, `"`, `$`, and backtick are escaped.
const quote = (text: string) => `"${text.replace(/[\\"$`]/g, "\\$&")}"`;

/**
 * The launch arguments that give a session standing instructions the provider re-sends after every
 * compaction. Claude Code also loses its built-in subagent tool, whose children T3 creates outside the registry.
 */
function standingArgs(driver: string, rules: string): string | null {
  switch (driver) {
    case "claudeAgent":
      return `--append-system-prompt ${quote(rules)} --disallowedTools ${quote("Task,Agent")}`;
    case "codex":
      // Codex reads the value as TOML, and a JSON string is a valid TOML basic string.
      return `-c ${quote(`developer_instructions=${JSON.stringify(rules)}`)}`;
    default:
      return null;
  }
}

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

/**
 * Copies the picked instance's binary, home, environment, and own launch arguments into one
 * orchestrator instance, and adds the rules. A change to the rules updates that instance, so
 * the engine never holds a second one. Every other instance is left as it is. The write is an
 * upsert, so two boards that start together cannot fail on each other's create.
 */
export function planOrchestratorInstance(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly base: { readonly instanceId: string; readonly driver: string };
  readonly rules: string;
}): OrchestratorInstancePlan {
  const { providerInstances, base, rules } = input;
  const instanceId = orchestratorInstanceId(base.instanceId);
  const args = standingArgs(base.driver, rules);
  if (args === null) {
    throw new Error(`The board has no orchestrator rules for ${base.driver}.`);
  }
  const source = instanceAt(providerInstances, base.instanceId);
  const sourceConfig = configOf(source);
  const own = sourceConfig.launchArgs?.trim() ?? "";
  const launchArgs = own === "" ? args : `${own} ${args}`;

  const existing = instanceAt(providerInstances, instanceId);
  if (existing?.enabled !== false && configOf(existing).launchArgs === launchArgs) {
    return { instanceId, mutation: null };
  }
  const instance: ProviderInstanceConfig = {
    ...source,
    driver: ProviderDriverKind.make(base.driver),
    displayName: `${source?.displayName ?? base.instanceId} (board orchestrator)`,
    enabled: true,
    config: { ...sourceConfig, launchArgs },
  };
  return {
    instanceId,
    mutation: {
      operation: "upsert",
      instanceId: ProviderInstanceId.make(instanceId),
      instance,
    },
  };
}
