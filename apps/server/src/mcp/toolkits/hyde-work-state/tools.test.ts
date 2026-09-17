import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import { HydeWorkStateCheckpointTool, HydeWorkStateReadTool } from "./tools.ts";

it("advertises Codex-compatible empty input for the HYDE work-state read tool", () => {
  const readSchema = Tool.getJsonSchema(HydeWorkStateReadTool) as Record<string, unknown>;

  expect(readSchema).toEqual({
    type: "object",
    additionalProperties: false,
  });
  expect(Schema.decodeUnknownSync(Tool.EmptyParams)({})).toEqual({});
  expect(() => Schema.decodeUnknownSync(Tool.EmptyParams)(null)).toThrow();
  expect(readSchema).not.toBeNull();
  expect(readSchema.type).not.toBe("None");
});

it("preserves the checkpoint tool's structured object schema", () => {
  const checkpointSchema = Tool.getJsonSchema(HydeWorkStateCheckpointTool) as {
    readonly type?: unknown;
    readonly properties?: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(checkpointSchema.type).toBe("object");
  expect(checkpointSchema.properties).toHaveProperty("expectedRevision");
  expect(checkpointSchema.properties).toHaveProperty("state");
  expect(checkpointSchema.required).toEqual(["expectedRevision", "state"]);
});
