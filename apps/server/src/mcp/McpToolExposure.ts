import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { McpToolExposureMode } from "@t3tools/provider-core/server/mcpSession";

import type { McpCapability } from "./McpInvocationContext.ts";

export const TOOL_SEARCH = "tool_search";

/** Listed first in every mode. Pi's extension declares the same three. */
const CORE_TOOLS = ["orchestrator_capabilities", "delegate_task", "task_status"];

// Antigravity kept 33.8 KB of tool definitions on a Mac with many skills (52.9 KB on one with few).
const BUDGETED_LISTING_BYTES = 28_000;

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ListingSession {
  readonly providerSessionId: string;
  readonly capabilities: ReadonlySet<McpCapability>;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query and lists them to the session from now on. */
    readonly search: (
      providerSessionId: string,
      query: string,
    ) => Effect.Effect<ReadonlyArray<ListedTool>>;
    readonly isListed: (
      session: ListingSession,
      mode: McpToolExposureMode,
      tool: string,
    ) => boolean;
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

const definitionBytes = ({ name, description, inputSchema }: ListedTool) =>
  new TextEncoder().encode(JSON.stringify({ name, description, parameters: inputSchema })).length;

export const make = (
  tools: () => ReadonlyArray<ListedTool>,
  announceListChanged: () => Effect.Effect<void>,
  capabilityTools: ReadonlyMap<McpCapability, ReadonlyArray<string>>,
) => {
  const priorityTools = (capabilities: ReadonlySet<McpCapability>) =>
    new Set([
      ...CORE_TOOLS,
      ...[...capabilityTools].flatMap(([capability, names]) =>
        capabilities.has(capability) ? names : [],
      ),
    ]);
  // Fills the budget smallest-first after the priority tools, so the dropped tail is the same every time.
  const budgetedListing = (capabilities: ReadonlySet<McpCapability>) => {
    const priority = priorityTools(capabilities);
    const candidates = tools().filter((tool) => tool.name !== TOOL_SEARCH);
    const listed = new Set<string>();
    let bytes = 0;
    for (const tool of candidates.filter((candidate) => priority.has(candidate.name))) {
      listed.add(tool.name);
      bytes += definitionBytes(tool);
    }
    const rest = candidates
      .filter((candidate) => !priority.has(candidate.name))
      .map((tool) => ({ name: tool.name, bytes: definitionBytes(tool) }))
      .sort((a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name));
    for (const tool of rest) {
      if (bytes + tool.bytes > BUDGETED_LISTING_BYTES) break;
      listed.add(tool.name);
      bytes += tool.bytes;
    }
    return listed;
  };
  const budgeted = new Map<string, ReadonlySet<string>>();
  const budgetedFor = (capabilities: ReadonlySet<McpCapability>) => {
    const key = [...capabilities].sort().join(",");
    const cached = budgeted.get(key);
    if (cached !== undefined) return cached;
    const listing = budgetedListing(capabilities);
    budgeted.set(key, listing);
    return listing;
  };
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
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const found = tools()
        .filter((tool) => tool.name !== TOOL_SEARCH)
        .map((tool) => ({ tool, score: score(tool, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((match) => match.tool);
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        yield* announceListChanged();
      }
      return found;
    }),
    isListed: (session, mode, tool) =>
      mode === "budgeted"
        ? budgetedFor(session.capabilities).has(tool)
        : tool === TOOL_SEARCH ||
          priorityTools(session.capabilities).has(tool) ||
          loaded.get(session.providerSessionId)?.has(tool) === true,
  });
};
