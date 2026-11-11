import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

export const directToolNames = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "request_secret",
]);

export const ToolDiscoveryToolkit = Toolkit.make(
  Tool.make("search_tools", {
    description:
      "Find optional T3 tools by name or keywords. Returns up to five tool definitions. Empty query lists names and descriptions. Call a result with call_tool using its name and arguments matching its inputSchema.",
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.Unknown,
  }).annotate(Tool.Readonly, true),
  Tool.make("call_tool", {
    description:
      "Call an optional T3 tool found with search_tools. Pass its exact name and arguments matching the returned inputSchema. The target tool's permissions and approval requirements apply.",
    parameters: Schema.Struct({
      name: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.Unknown),
    }),
    success: Schema.Unknown,
  }),
);

export const searchToolDefinitions = <
  T extends { readonly name: string; readonly description?: string | undefined },
>(
  tools: ReadonlyArray<T>,
  query: string,
) => {
  const normalized = query.toLowerCase().trim();
  const terms = normalized.split(/\s+/).filter(Boolean);
  const matches = tools.filter((tool) =>
    terms.every((term) => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(term)),
  );
  return terms.length === 0
    ? matches.map(({ name, description }) => ({ name, description }))
    : matches
        .sort(
          (a, b) =>
            Number(b.name.toLowerCase() === normalized) -
            Number(a.name.toLowerCase() === normalized),
        )
        .slice(0, 5);
};
