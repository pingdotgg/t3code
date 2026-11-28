import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});

const advertisedOptions = (
  tool: Parameters<typeof advertisedJsonSchema>[0],
  path: ReadonlyArray<string>,
) => {
  let node: unknown = advertisedJsonSchema(tool);
  for (const key of path) {
    node =
      typeof node === "object" && node !== null && "properties" in node
        ? (node as { properties?: Record<string, unknown> }).properties?.[key]
        : undefined;
  }
  return node;
};

const optionObjectMap = {
  type: "object",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "boolean" }] },
};

it("advertises target.options and modelSelection.options as an object map, not an array-or-object union", () => {
  const delegate = advertisedOptions(OrchestratorToolkit.tools.delegate_task, [
    "target",
    "options",
  ]);
  expect(delegate).toEqual({
    description:
      "Ids vary by provider; see `orchestrator_capabilities`. Given values override inherited. [] or {} clears.",
    ...optionObjectMap,
  });
  expect(delegate).not.toHaveProperty("anyOf");

  for (const tool of [
    ProjectToolkit.tools.t3_thread_launch,
    ThreadToolkit.tools.t3_thread_configure,
  ]) {
    const options = advertisedOptions(tool, ["modelSelection", "options"]);
    expect(options, tool.name).toMatchObject({ type: "object" });
    expect(options, tool.name).not.toHaveProperty("anyOf");
    expect(options, tool.name).not.toHaveProperty("items");
  }
});
