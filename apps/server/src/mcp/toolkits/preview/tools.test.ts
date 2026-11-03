import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { PreviewToolkit } from "./tools.ts";

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const descriptionCount = allOf.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      typeof (member as Record<string, unknown>).description === "string",
  ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
  }
});

it("preview_open accepts a target while preserving open input constraints", () => {
  const decode = Schema.decodeUnknownSync(PreviewToolkit.tools.preview_open.parametersSchema);
  const target = { kind: "environment-port", port: 3000 };
  expect(decode({ target })).toEqual({ target });
  expect(decode({})).toEqual({});
  expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
  expect(decode({ url: "http://localhost:3000", target })).toEqual({
    url: "http://localhost:3000",
    target,
  });
  expect(() => decode({ target: { ...target, port: 0 } })).toThrow();
  expect(() => decode({ target, tabId: "tab-1", reuseExistingTab: false })).toThrow();
});
