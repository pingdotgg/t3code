import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { WorkspaceToolkit } from "./tools.ts";

it("exports described workspace tools", () => {
  const names = Object.values(WorkspaceToolkit.tools).map((tool) => tool.name);
  expect(names).toEqual([
    "list_projects",
    "create_project",
    "list_threads",
    "get_thread",
    "list_providers",
    "start_thread",
    "follow_up",
    "interrupt_thread",
    "respond_to_approval",
    "settle_thread",
    "unsettle_thread",
  ]);

  for (const tool of Object.values(WorkspaceToolkit.tools)) {
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    const schema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
  }
});
