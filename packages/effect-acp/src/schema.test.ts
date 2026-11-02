import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as V1 from "./_generated/schema-v1.gen.ts";
import * as V2 from "./schema.ts";

describe("pinned ACP wire schemas", () => {
  it("validates known content variants without accepting malformed ones as future content", () => {
    const accepts = Schema.is(V2.ContentBlock);
    expect(accepts({ type: "text", text: "hello" })).toBe(true);
    expect(accepts({ type: "text" })).toBe(false);
    expect(accepts({ type: "image", data: "aGVsbG8=" })).toBe(false);
    expect(accepts({ type: "future_content", payload: { value: 1 } })).toBe(true);
  });

  it("keeps v1 command inputs compatible with native agents", () => {
    const command = { name: "plan", description: "Make a plan", input: { hint: "Task" } };
    const isAvailableCommand = Schema.is(V1.AvailableCommand);

    expect(isAvailableCommand(command)).toBe(true);
    const isAvailableCommand2 = Schema.is(V2.AvailableCommand);

    expect(isAvailableCommand2({ ...command, input: { type: "text", hint: "Task" } })).toBe(true);
  });
});
