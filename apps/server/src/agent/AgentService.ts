/**
 * AgentService — filesystem discovery of custom agents for thread startup and
 * delegated tasks. An agent is a markdown file: its YAML
 * frontmatter holds the `AgentDefinition` fields and its body is the
 * instructions. Agents come from `.agents/*.md`, then `.github/agents/*.md`,
 * then the project's `AGENTS.md`, and the first definition of an id wins.
 *
 * A file without frontmatter is project guidance rather than an agent, so it
 * is skipped quietly. Frontmatter that is not a YAML mapping or fails to decode
 * is skipped with a warning, so one broken file never hides the others.
 *
 * @module agent/AgentService
 */
import {
  AgentDefinition,
  type AgentId,
  type AgentSummary,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderAvailable,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const decodeAgentDefinition = Schema.decodeUnknownEffect(AgentDefinition);

/** The frontmatter mapping, or undefined when the YAML does not parse to one. */
function parseFrontmatter(source: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(source);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** Markdown files that may define agents, in precedence order. */
const listAgentFiles = Effect.fn("listAgentFiles")(function* (workspaceRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: string[] = [];
  for (const directory of [
    path.join(workspaceRoot, ".agents"),
    path.join(workspaceRoot, ".github", "agents"),
  ]) {
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      if (entry.endsWith(".md")) {
        files.push(path.join(directory, entry));
      }
    }
  }
  return [...files, path.join(workspaceRoot, "AGENTS.md")];
});

/** The agent a file defines, or undefined when it defines none. */
const readAgentFile = Effect.fn("readAgentFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const match = contents === undefined ? null : FRONTMATTER_PATTERN.exec(contents);
  if (contents === undefined || match === null) {
    return undefined;
  }
  const frontmatter = parseFrontmatter(match[1] ?? "");
  if (frontmatter === undefined) {
    yield* Effect.logWarning("agent frontmatter did not parse as a YAML mapping; skipping", {
      path: filePath,
    });
    return undefined;
  }
  if (Object.hasOwn(frontmatter, "tools")) {
    yield* Effect.logWarning("agent tools frontmatter is not supported and was ignored", {
      path: filePath,
    });
  }
  const instructions = contents.slice(match[0].length).trim();
  return yield* decodeAgentDefinition({ ...frontmatter, instructions }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("agent definition is invalid; skipping", { path: filePath, cause }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});

/** Every valid agent in a worktree, keeping the first definition of each id. */
const discoverAgentDefinitions = Effect.fn("discoverAgentDefinitions")(function* (
  workspaceRoot: string | null,
) {
  if (!workspaceRoot) {
    return [];
  }
  const agents = new Map<string, AgentDefinition>();
  const filePaths = yield* listAgentFiles(workspaceRoot);
  for (const filePath of filePaths) {
    const agent = yield* readAgentFile(filePath);
    if (agent === undefined) {
      continue;
    }
    if (agents.has(agent.id)) {
      yield* Effect.logWarning("agent id is defined more than once; keeping the first", {
        id: agent.id,
        path: filePath,
      });
      continue;
    }
    agents.set(agent.id, agent);
  }
  return [...agents.values()];
});

export const listAgentDefinitions = discoverAgentDefinitions;

export function summarizeAgentDefinition(agent: AgentDefinition): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    ...(agent.tier === undefined ? {} : { tier: agent.tier }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
  };
}

/** The roster the composer and `orchestrator_capabilities` advertise. */
export const listAgentSummaries = Effect.fn("listAgentSummaries")(function* (
  workspaceRoot: string | null,
) {
  const agents = yield* listAgentDefinitions(workspaceRoot);
  return agents.map(summarizeAgentDefinition);
});

/** The definition an id names, read from the same locations as `listAgentSummaries`. */
export const getAgentDefinition = Effect.fn("getAgentDefinition")(function* (
  agentId: AgentId,
  workspaceRoot: string | null,
) {
  const agents = yield* listAgentDefinitions(workspaceRoot);
  return Option.fromNullishOr(agents.find((agent) => agent.id === agentId));
});

/**
 * The model an agent uses at a thread or delegation boundary. An explicit
 * `model` in the agent file wins when that exact instance/model is available.
 * Otherwise an explicit tier picks the first available provider that advertises
 * its default model, preferring the current instance. An omitted model and tier
 * leave the child on its selected or inherited model.
 */
export function resolveModelForAgent(
  agent: AgentDefinition,
  availableProviders: ReadonlyArray<ServerProvider>,
  preferredInstanceId?: ModelSelection["instanceId"],
): ModelSelection | undefined {
  if (agent.model !== undefined) {
    const provider = availableProviders.find(
      (candidate) =>
        candidate.instanceId === agent.model?.instanceId &&
        canRunAgentModel(candidate) &&
        candidate.models.some((model) => model.slug === agent.model?.model),
    );
    return provider === undefined ? undefined : agent.model;
  }
  if (agent.tier === undefined) return undefined;
  const tierDefaults =
    agent.tier === "economy"
      ? DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER
      : DEFAULT_MODEL_BY_PROVIDER;
  const orderedProviders = availableProviders.toSorted((left, right) => {
    if (left.instanceId === preferredInstanceId) {
      return right.instanceId === preferredInstanceId ? 0 : -1;
    }
    if (right.instanceId === preferredInstanceId) return 1;
    return 0;
  });
  for (const provider of orderedProviders) {
    const model = tierDefaults[provider.driver];
    if (
      model !== undefined &&
      canRunAgentModel(provider) &&
      provider.models.some((candidate) => candidate.slug === model)
    ) {
      return { instanceId: provider.instanceId, model };
    }
  }
  return undefined;
}

function canRunAgentModel(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated"
  );
}
