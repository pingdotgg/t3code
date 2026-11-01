import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_MCP_TOOL_PRESENTATION_PROMPT = [
  "Do exactly this, one tool call at a time, with no other tool calls:",
  '1) Call the Firecrawl firecrawl_scrape tool on https://example.com with formats ["markdown"].',
  "2) Call the Firecrawl firecrawl_map tool on https://example.com with limit 1.",
  "3) Reply with exactly: mcp presentation fixture complete",
].join("\n");

export function claudeMcpToolPresentationInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_MCP_TOOL_PRESENTATION_PROMPT }],
  };
}
