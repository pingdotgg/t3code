import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const TOOL_SEARCH = "tool_search";

/** What a deferring client lists before it searches. Pi's extension declares the same three. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  TOOL_SEARCH,
]);

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

/**
 * Tools for a job few threads do. `tool_search` with the pack's name loads all of
 * them, and they stay outside the gated tool budget (AgentContextBudget.test.ts).
 */
export const PACKS = {
  customization: "restyle T3 Code itself",
} as const;

export type PackName = keyof typeof PACKS;

/** Tool annotation that puts a tool in a pack. */
export class Pack extends Context.Service<Pack, PackName>()("t3/mcp/McpToolExposure/Pack") {}

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly pack?: PackName | undefined;
}

export interface ToolSearchCaller {
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query and lists them to the session from now on. */
    readonly search: (
      caller: ToolSearchCaller,
      query: string,
    ) => Effect.Effect<ReadonlyArray<ListedTool>>;
    readonly isListed: (providerSessionId: string, tool: string) => boolean;
    /** True once, when the session lists tools for the first time after a search loaded some. */
    readonly relisted: (providerSessionId: string) => boolean;
  }
>()("t3/mcp/McpToolExposure") {}

const score = (tool: ListedTool, terms: ReadonlyArray<string>) => {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term === name) total += 100;
    else if (name.includes(term)) total += 3;
    else if (description.includes(term)) total += 1;
  }
  return total;
};

export const make = (
  tools: () => ReadonlyArray<ListedTool>,
  announceListChanged: () => Effect.Effect<void>,
) => {
  const loaded = new Map<string, Set<string>>();
  const load = (providerSessionId: string, names: ReadonlyArray<string>) => {
    const listed = loaded.get(providerSessionId) ?? new Set<string>();
    loaded.delete(providerSessionId);
    loaded.set(providerSessionId, listed);
    for (const name of names) listed.add(name);
    for (const oldest of loaded.keys()) {
      if (loaded.size <= MAX_SESSIONS) break;
      loaded.delete(oldest);
      awaitingRelist.delete(oldest);
      relisters.delete(oldest);
    }
  };
  // Sessions whose last search loaded tools and that have not listed tools since.
  const awaitingRelist = new Set<string>();
  // A harness that lists lazily can search twice before it lists, so only warn about
  // sessions that have never listed after a search.
  const relisters = new Set<string>();
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (caller, query) {
      const { providerSessionId } = caller;
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const candidates = tools().filter((tool) => tool.name !== TOOL_SEARCH);
      const inNamedPack = (tool: ListedTool) =>
        tool.pack !== undefined && terms.includes(tool.pack);
      const found = [
        ...candidates.filter(inNamedPack),
        ...candidates
          .filter((tool) => !inNamedPack(tool))
          .map((tool) => ({ tool, score: score(tool, terms) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_RESULTS)
          .map((match) => match.tool),
      ];
      if (awaitingRelist.has(providerSessionId) && !relisters.has(providerSessionId)) {
        // The harness ignored list_changed, so its model cannot see what the search loads.
        yield* Effect.logWarning("mcp.tool-search.not-relisted", caller);
      }
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        awaitingRelist.add(providerSessionId);
        yield* announceListChanged();
      }
      return found;
    }),
    isListed: (providerSessionId, tool) =>
      DIRECT_TOOLS.has(tool) || loaded.get(providerSessionId)?.has(tool) === true,
    relisted: (providerSessionId) => {
      if (!awaitingRelist.delete(providerSessionId)) return false;
      relisters.add(providerSessionId);
      return true;
    },
  });
};
