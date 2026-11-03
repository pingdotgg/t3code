import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  flattenCompositions,
  generateSchemaOutput,
  normalizeSchemaKeywords,
} from "./schemaTransform.ts";

// Regression setup: ACP's `TitledMultiSelectItems` uses `anyOf` as a property name. The
// traversal must treat `properties` keys as property names, never as keywords.
const upstreamDefs = {
  EnumOption: {
    type: "object",
    properties: {
      const: { type: "string", description: "The value to submit." },
      title: { type: "string" },
    },
    required: ["const", "title"],
  },
  TitledMultiSelectItems: {
    type: "object",
    properties: {
      anyOf: {
        type: "array",
        items: { $ref: "#/$defs/EnumOption" },
        minItems: 1,
        description: "Titled enum options.",
      },
    },
    required: ["anyOf"],
  },
} as const;

describe("ACP schema transform", () => {
  it("keeps a property named anyOf through the schema traversal", () => {
    const flattened = flattenCompositions(
      normalizeSchemaKeywords(upstreamDefs.TitledMultiSelectItems),
      upstreamDefs,
    );

    if (typeof flattened !== "object" || flattened === null || Array.isArray(flattened)) {
      throw new Error("Expected an object schema");
    }
    const properties = (flattened as { readonly properties?: Schema.Json }).properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      throw new Error("Expected an object schema with properties");
    }
    expect(Object.keys(properties)).toContain("anyOf");
  });

  it("generates a schema whose anyOf property survives instead of becoming Schema.Never", () => {
    const { output } = generateSchemaOutput({ $defs: { ...upstreamDefs } }, "schema-test-release");

    expect(output).toContain("TitledMultiSelectItems");
    expect(output).toMatch(/"anyOf": Schema\.Array\(EnumOption\)/);
    expect(output).not.toContain("Schema.Never");
  });
});
