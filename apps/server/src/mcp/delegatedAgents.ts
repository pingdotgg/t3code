import {
  ProviderInteractionMode,
  ProviderOptionSelectionValue,
  ProviderInstanceId,
  RuntimeMode,
  startsWithProviderCommand,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTarget,
  type ProjectAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

export const AGENT_DEFINITIONS_DIRECTORY = ".agents/agents";
/** Relative to the T3 home; holds the agents every project can use. */
export const USER_AGENT_DEFINITIONS_DIRECTORY = "agents";

const MAX_AGENT_FILES = 50;
const MAX_AGENT_FILE_BYTES = 64 * 1024;
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const AgentFrontmatter = Schema.Struct({
  description: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderInstanceId),
  model: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Record(Schema.String, ProviderOptionSelectionValue)),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  isolation: Schema.optional(Schema.Literals(["shared", "worktree"])),
});
const decodeFrontmatter = Schema.decodeUnknownOption(AgentFrontmatter);

/** A named agent a user defined in `.agents/agents/<name>.md`; its body is the agent's instructions. */
export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly target:
    | Pick<OrchestratorMcpTarget, "providerInstanceId" | "model" | "options">
    | undefined;
  readonly runtimeMode: OrchestratorMcpDelegateTaskInput["runtimeMode"];
  readonly interactionMode: OrchestratorMcpDelegateTaskInput["interactionMode"];
  readonly isolation: OrchestratorMcpDelegateTaskInput["isolation"];
}

/** Null for a file that is not a usable definition, so one bad file never hides the others. */
export function parseAgentDefinition(name: string, source: string): AgentDefinition | null {
  if (!AGENT_NAME_PATTERN.test(name)) return null;
  const contents = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = FRONTMATTER_PATTERN.exec(contents);
  let raw: unknown = {};
  if (match) {
    try {
      raw = parseYaml(match[1] ?? "") ?? {};
    } catch {
      return null;
    }
  }
  const frontmatter = decodeFrontmatter(raw);
  if (Option.isNone(frontmatter)) return null;
  const { description, provider, model, options, runtimeMode, interactionMode, isolation } =
    frontmatter.value;
  const instructions = (match ? contents.slice(match[0].length) : contents).trim();
  if (instructions === "") return null;
  const target =
    provider === undefined && model === undefined && options === undefined
      ? undefined
      : {
          ...(provider === undefined ? {} : { providerInstanceId: provider }),
          ...(model === undefined ? {} : { model }),
          ...(options === undefined
            ? {}
            : { options: Object.entries(options).map(([id, value]) => ({ id, value })) }),
        };
  return {
    name,
    description: description?.trim() ?? "",
    instructions,
    target,
    runtimeMode,
    interactionMode,
    isolation,
  };
}

const readDirectoryDefinitions = Effect.fn("DelegatedAgents.readDirectory")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const definitions = yield* Effect.forEach(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .toSorted()
      .slice(0, MAX_AGENT_FILES),
    (entry) =>
      fileSystem.readFileString(path.join(directory, entry)).pipe(
        Effect.map((contents) =>
          contents.length > MAX_AGENT_FILE_BYTES
            ? null
            : parseAgentDefinition(entry.slice(0, -".md".length), contents),
        ),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 8 },
  );
  return definitions.filter((definition) => definition !== null);
});

/**
 * Reads the definitions in a checkout plus the user's own, ordered by name. The project's
 * definition wins when both define a name. A missing directory, or no checkout, has none.
 */
export const loadAgentDefinitions = Effect.fn("DelegatedAgents.load")(function* (
  cwd: string | null,
  userDirectory: string,
) {
  const path = yield* Path.Path;
  const project =
    cwd === null
      ? []
      : yield* readDirectoryDefinitions(path.join(cwd, AGENT_DEFINITIONS_DIRECTORY));
  const user = yield* readDirectoryDefinitions(userDirectory);
  const projectNames = new Set(project.map((definition) => definition.name));
  return [...project, ...user.filter((definition) => !projectNames.has(definition.name))].toSorted(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
});

/**
 * The caller's provider, model and options win individually. Models belong to a provider and
 * option ids to a model, so choosing a different provider or model leaves the agent's behind.
 */
function mergeTarget(
  requested: OrchestratorMcpDelegateTaskInput["target"],
  defaults: AgentDefinition["target"],
): OrchestratorMcpDelegateTaskInput["target"] {
  if (defaults === undefined) return requested;
  if (requested === undefined) return defaults;
  const providerChanged =
    requested.driverKind !== undefined ||
    (requested.providerInstanceId !== undefined &&
      requested.providerInstanceId !== defaults.providerInstanceId);
  if (providerChanged) return requested;
  const modelChanged = requested.model !== undefined && requested.model !== defaults.model;
  const defaultOptions = modelChanged ? undefined : defaults.options;
  const options =
    requested.options === undefined || defaultOptions === undefined
      ? (requested.options ?? defaultOptions)
      : requested.options.length === 0
        ? requested.options
        : [
            ...defaultOptions.filter(
              (option) => !requested.options?.some(({ id }) => id === option.id),
            ),
            ...requested.options,
          ];
  const model = requested.model ?? defaults.model;
  return {
    ...requested,
    ...(requested.providerInstanceId === undefined && defaults.providerInstanceId !== undefined
      ? { providerInstanceId: defaults.providerInstanceId }
      : {}),
    ...(model === undefined ? {} : { model }),
    ...(options === undefined ? {} : { options }),
  };
}

/** The delegation with the agent's instructions and defaults applied; what the caller passed wins. */
export function applyAgentDefinition(
  input: OrchestratorMcpDelegateTaskInput,
  agent: AgentDefinition,
): OrchestratorMcpDelegateTaskInput {
  const target = mergeTarget(input.target, agent.target);
  return {
    ...input,
    task: `${agent.instructions}\n\n${input.task}`,
    ...(target === undefined ? {} : { target }),
    ...(input.runtimeMode === undefined && agent.runtimeMode !== undefined
      ? { runtimeMode: agent.runtimeMode }
      : {}),
    ...(input.interactionMode === undefined && agent.interactionMode !== undefined
      ? { interactionMode: agent.interactionMode }
      : {}),
    ...(input.isolation === undefined && agent.isolation !== undefined
      ? { isolation: agent.isolation }
      : {}),
  };
}

/** What a client needs to offer the agent in a chat; the instructions stay on the server. */
export function projectAgentFromDefinition(agent: AgentDefinition): ProjectAgent {
  return {
    name: agent.name,
    description: agent.description,
    ...(agent.target?.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: agent.target.providerInstanceId }),
    ...(agent.target?.model === undefined ? {} : { model: agent.target.model }),
    ...(agent.target?.options === undefined ? {} : { options: agent.target.options }),
  };
}

/**
 * The prompt a chat sends to the agent the user picked: its instructions, then the message. A
 * leading slash command or skill mention stays first, since its provider parses it from there.
 */
export function withAgentInstructions(agent: AgentDefinition, text: string): string {
  const intro = `[T3 Code: the user picked the named agent ${JSON.stringify(agent.name)} for this chat. Act as that agent and follow its instructions until the user picks another.]`;
  if (startsWithProviderCommand(text)) {
    return [text, intro, agent.instructions].join("\n\n");
  }
  return [
    intro,
    agent.instructions,
    "[T3 Code: end of the agent's instructions. The user's message follows.]",
    text,
  ].join("\n\n");
}
