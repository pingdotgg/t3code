import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

// Codex native spawn copies the parent's reasoning effort and service tier, so inherited
// Codex options alone must not push plain subagent requests onto delegate_task (#23525).
it.each(["delegate_task", "create_threads"] as const)(
  "%s does not route every inherited-options subagent away from native spawn",
  (name) => {
    expect(OrchestratorToolkit.tools[name].description).not.toMatch(
      /no model options are requested or inherited/i,
    );
  },
);

it("delegate_task says inherited Codex options alone do not require it", () => {
  expect(OrchestratorToolkit.tools.delegate_task.description).toMatch(
    /inherited Codex options alone do not require delegate_task/i,
  );
});
