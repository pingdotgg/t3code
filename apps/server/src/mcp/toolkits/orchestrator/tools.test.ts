import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorCapabilitiesTool,
  ScheduleTaskTool,
  ThreadInterruptTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
  });

  it("documents slim and paginated capability discovery", () => {
    const schema = Tool.getJsonSchema(OrchestratorCapabilitiesTool) as {
      readonly properties?: Readonly<Record<string, { readonly description?: unknown }>>;
    };

    assert.isString(schema.properties?.providerInstanceId?.description);
    assert.isString(schema.properties?.model?.description);
    assert.include(OrchestratorCapabilitiesTool.description ?? "", "no-argument response");
    assert.include(OrchestratorCapabilitiesTool.description ?? "", "modelCursor=modelsNextCursor");
    assert.include(OrchestratorCapabilitiesTool.description ?? "", "includeModelOptions=true");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("documents the no-runId root-run exclusion", () => {
    assert.include(ThreadInterruptTool.description ?? "", "waiting");
    assert.include(
      ThreadInterruptTool.description ?? "",
      "only when the thread shell reports provider-native background work",
    );
    assert.include(ThreadInterruptTool.description ?? "", "post-terminal-drain");
    assert.include(ThreadInterruptTool.description ?? "", "no-runId selection");
  });
});
