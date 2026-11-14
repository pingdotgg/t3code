import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
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

it("advertises only string enums, which Gemini requires", () => {
  const nonStringEnumValues = (schema: unknown): Array<unknown> => {
    if (Array.isArray(schema)) return schema.flatMap(nonStringEnumValues);
    if (typeof schema !== "object" || schema === null) return [];
    return Object.entries(schema).flatMap(([key, value]) =>
      key === "enum" && Array.isArray(value)
        ? value.filter((item) => typeof item !== "string")
        : nonStringEnumValues(value),
    );
  };

  expect(nonStringEnumValues(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set))).toEqual([]);
});
