import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
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

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});

it("decodes pipeline tool inputs and refuses empty or stale-shaped ones", () => {
  const decodeStart = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.start_pipeline.parametersSchema,
  );
  expect(
    Exit.isSuccess(decodeStart({ pipeline: "Feature delivery", prompt: "Add dark mode" })),
  ).toBe(true);
  expect(
    Exit.isSuccess(
      decodeStart({
        pipeline: "pipeline:starter:feature-delivery",
        prompt: "Add dark mode",
        worktree: true,
        clientRequestId: "start-1",
      }),
    ),
  ).toBe(true);
  expect(Exit.isFailure(decodeStart({ pipeline: "Feature delivery", prompt: "  " }))).toBe(true);
  expect(Exit.isFailure(decodeStart({ prompt: "Add dark mode" }))).toBe(true);

  const decodeContinue = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.continue_pipeline.parametersSchema,
  );
  expect(Exit.isSuccess(decodeContinue({ runId: "pipeline-run:one", stepIndex: 1 }))).toBe(true);
  expect(Exit.isFailure(decodeContinue({ runId: "pipeline-run:one" }))).toBe(true);
  expect(Exit.isFailure(decodeContinue({ runId: "pipeline-run:one", stepIndex: -1 }))).toBe(true);
});

// The Claude read-only allowlist is derived from these annotations (ClaudeAdapterV2.test.ts checks it).
it("marks only the pipeline reads as read-only", () => {
  const readonly = (name: keyof typeof OrchestratorToolkit.tools) =>
    Context.get(OrchestratorToolkit.tools[name].annotations, Tool.Readonly);
  expect(readonly("list_pipelines")).toBe(true);
  expect(readonly("pipeline_status")).toBe(true);
  expect(readonly("start_pipeline")).toBe(false);
  expect(readonly("continue_pipeline")).toBe(false);
  expect(readonly("revise_pipeline_step")).toBe(false);
  expect(readonly("cancel_pipeline")).toBe(false);
});
