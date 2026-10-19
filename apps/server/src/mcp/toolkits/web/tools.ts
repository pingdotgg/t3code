import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as WebTools from "../../../web/WebTools.ts";

const Provider = Schema.Literals(["firecrawl", "exa", "tavily"]).annotate({
  description: "The web provider that served this call, chosen in Settings → Web.",
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [WebTools.WebTools],
};

// Read-only in the MCP sense: they read the public web and change nothing
// here, so plan mode and read-only sandboxes can use them.
const WebSearchTool = Tool.make("web_search", {
  ...shared,
  description:
    "Search the web through the web provider chosen for this environment. Returns titles, URLs, and short snippets; use web_fetch to read a result in full. If it reports that T3 Code web tools are off, use your own web search instead.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)).annotate({
      description: "What to search for.",
    }),
    limit: Schema.optional(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(WebTools.MAX_WEB_SEARCH_RESULTS),
      ).annotate({
        description: `Number of results, 1-${WebTools.MAX_WEB_SEARCH_RESULTS}. Defaults to 5.`,
      }),
    ),
  }),
  success: Schema.Struct({
    provider: Provider,
    results: Schema.Array(
      Schema.Struct({ title: Schema.String, url: Schema.String, snippet: Schema.String }),
    ),
  }),
})
  .annotate(Tool.Title, "Web search")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const WebFetchTool = Tool.make("web_fetch", {
  ...shared,
  description: `Fetch a web page through the web provider chosen for this environment and return its main content as markdown. Pages past ${WebTools.MAX_WEB_FETCH_CHARS.toLocaleString("en-US")} characters are cut and marked truncated. If it reports that T3 Code web tools are off, use your own web fetch instead.`,
  parameters: Schema.Struct({
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description: "The http(s) URL of the page.",
    }),
  }),
  success: Schema.Struct({
    provider: Provider,
    url: Schema.String,
    title: Schema.String,
    content: Schema.String,
    truncated: Schema.Boolean,
  }),
})
  .annotate(Tool.Title, "Web fetch")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const WebToolkit = Toolkit.make(WebSearchTool, WebFetchTool);
