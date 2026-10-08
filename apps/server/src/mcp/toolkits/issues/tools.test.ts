import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Tool from "effect/ai/Tool";

import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import { IssuesToolkit } from "./tools.ts";

it("publishes a provider-compatible read-only issue tool with T3 labels", () => {
  const tool = IssuesToolkit.tools.read_issue;
  const schema = Tool.getJsonSchema(tool);
  expect(schema).toMatchObject({
    type: "object",
    required: ["repository", "number"],
    properties: {
      repository: { type: "string" },
      number: { type: "integer" },
      provider: { anyOf: [{ type: "string" }, { type: "null" }] },
      url: { anyOf: [{ type: "string" }, { type: "null" }] },
      commentsCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  });
  expect(JSON.stringify(schema)).not.toContain('"$ref"');
  expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  expect(resolveT3McpToolDefinition("read_issue")?.summaryAction).toBe("read-issue");
  for (const name of ["read_issue", "mcp__t3-code__read_issue", "T3-code.read_issue"]) {
    expect(resolveT3McpToolPresentation(name)).toEqual({
      displayName: "Read an issue",
      logo: "t3-code",
    });
  }
});
