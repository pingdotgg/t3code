import { describe, expect, it } from "vite-plus/test";

import { pluginSettingsForm } from "./pluginSettingsForm";

describe("pluginSettingsForm", () => {
  it("derives one field per supported property", () => {
    expect(
      pluginSettingsForm({
        type: "object",
        required: ["greeting"],
        properties: {
          greeting: { type: "string", title: "Greeting", default: "hi", maxLength: 40 },
          token: { type: "string", format: "t3-secret", description: "API token" },
          retries: { type: "integer", minimum: 0, maximum: 5, default: 2 },
          ratio: { type: "number" },
          verbose: { type: "boolean", default: false },
          mode: { enum: ["fast", "safe"], default: "safe" },
          tags: { type: "array", items: { type: "string" }, default: ["a"] },
        },
      }),
    ).toEqual({
      kind: "fields",
      fields: [
        {
          key: "greeting",
          label: "Greeting",
          description: undefined,
          required: true,
          kind: "text",
          defaultValue: "hi",
          maxLength: 40,
        },
        { key: "token", label: "token", description: "API token", required: false, kind: "secret" },
        {
          key: "retries",
          label: "retries",
          description: undefined,
          required: false,
          kind: "number",
          integer: true,
          defaultValue: 2,
          minimum: 0,
          maximum: 5,
        },
        {
          key: "ratio",
          label: "ratio",
          description: undefined,
          required: false,
          kind: "number",
          integer: false,
          defaultValue: undefined,
          minimum: undefined,
          maximum: undefined,
        },
        {
          key: "verbose",
          label: "verbose",
          description: undefined,
          required: false,
          kind: "boolean",
          defaultValue: false,
        },
        {
          key: "mode",
          label: "mode",
          description: undefined,
          required: false,
          kind: "select",
          options: ["fast", "safe"],
          defaultValue: "safe",
        },
        {
          key: "tags",
          label: "tags",
          description: undefined,
          required: false,
          kind: "list",
          defaultValue: ["a"],
        },
      ],
    });
  });

  it.each([
    ["no schema", undefined, "none"],
    ["an object without properties", { type: "object", properties: {} }, "none"],
    ["a nested object", { type: "object", properties: { a: { type: "object" } } }, "json"],
    [
      "a list of numbers",
      { type: "object", properties: { a: { type: "array", items: { type: "number" } } } },
      "json",
    ],
    ["a union", { type: "object", properties: { a: { anyOf: [{ type: "string" }] } } }, "json"],
    ["a non-object root", { type: "string" }, "json"],
  ] as const)("gives %s the right form kind", (_name, schema, kind) => {
    expect(pluginSettingsForm(schema).kind).toBe(kind);
  });
});
