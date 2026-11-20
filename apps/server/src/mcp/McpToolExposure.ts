import type { McpToolExposureMode } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const TOOL_SEARCH = "tool_search";
export const TOOL_CALL = "tool_call";

/** What a deferring client lists before it searches. Pi's extension declares the same three. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  TOOL_SEARCH,
]);

const PROXY_DIRECT_TOOLS: ReadonlySet<string> = new Set([...DIRECT_TOOLS, TOOL_CALL]);

const MAX_RESULTS = 10;
// Antigravity caps inline MCP tool results around 10 KB; stay comfortably under it so JSON schemas never truncate.
const MAX_PROXY_SCHEMA_BYTES = 8_000;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}

export interface SearchableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly isEnabled?: () => boolean;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query and, in dynamic mode, lists them to the session from now on. */
    readonly search: (
      providerSessionId: string,
      query: string,
      options?: { readonly mode?: McpToolExposureMode | undefined },
    ) => Effect.Effect<ReadonlyArray<ListedTool>>;
    readonly isListed: (
      providerSessionId: string,
      tool: string,
      mode?: McpToolExposureMode,
    ) => boolean;
  }
>()("t3/mcp/McpToolExposure") {}

const score = (
  tool: Pick<SearchableTool, "name" | "description">,
  terms: ReadonlyArray<string>,
) => {
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

const utf8Bytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const make = (
  tools: () => ReadonlyArray<SearchableTool>,
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
    }
  };
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query, options) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const found = tools()
        .filter(
          (tool) =>
            tool.name !== TOOL_SEARCH &&
            tool.name !== TOOL_CALL &&
            (tool.isEnabled === undefined || tool.isEnabled()),
        )
        .map((tool) => ({ tool, score: score(tool, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((match) => match.tool);
      if (options?.mode === "deferred-proxy") {
        const results: Array<ListedTool> = [];
        for (const tool of found) {
          const withSchema: ListedTool = {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          };
          if (utf8Bytes({ tools: [...results, withSchema] }) <= MAX_PROXY_SCHEMA_BYTES) {
            results.push(withSchema);
            continue;
          }
          const compact: ListedTool = { name: tool.name, description: tool.description };
          if (utf8Bytes({ tools: [...results, compact] }) <= MAX_PROXY_SCHEMA_BYTES) {
            results.push(compact);
            continue;
          }
          if (results.length === 0) {
            results.push({
              name: tool.name,
              description: `${tool.description.slice(0, 200)} (Truncated: exceeds response budget.)`,
            });
          }
          break;
        }
        return results;
      }
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        yield* announceListChanged();
      }
      return found.map(({ name, description }) => ({ name, description }));
    }),
    isListed: (providerSessionId, tool, mode = "deferred") =>
      mode === "deferred-proxy"
        ? PROXY_DIRECT_TOOLS.has(tool)
        : DIRECT_TOOLS.has(tool) || loaded.get(providerSessionId)?.has(tool) === true,
  });
};
