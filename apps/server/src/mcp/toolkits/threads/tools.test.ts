import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ThreadToolkit } from "./tools.ts";

it("exports provider-compatible thread management schemas", () => {
  expect(Object.keys(ThreadToolkit.tools).sort()).toEqual([
    "thread_archive",
    "thread_create",
    "thread_fork",
    "thread_list",
    "thread_send",
  ]);

  for (const tool of Object.values(ThreadToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
  }
});
