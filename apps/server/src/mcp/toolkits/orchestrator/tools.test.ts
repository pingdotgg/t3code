import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorToolkit,
  ScheduleTaskTool,
  ThreadUpdateTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
    assert.include(DelegateTaskTool.description ?? "", "waitTimedOut");
    assert.include(DelegateTaskTool.description ?? "", "does not cancel the child");
    assert.include(DelegateTaskTool.description ?? "", "keep that taskId");
    assert.include(DelegateTaskTool.description ?? "", "call delegate_task again");
    assert.include(DelegateTaskTool.description ?? "", "childThreadId is backing storage");
    assert.include(
      OrchestratorToolkit.tools.t3_thread_send.description ?? "",
      "a requested follow-up creates a fresh task",
    );
    assert.include(
      OrchestratorToolkit.tools.task_cancel.description ?? "",
      "This includes later child-thread runs, even after the task is terminal",
    );
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Defaults to async");
    assert.include(timeoutText, "does not cancel the child");
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

  it("offers the environment selector on thread read and wait as an optional field", () => {
    for (const tool of [
      OrchestratorToolkit.tools.t3_thread_read,
      OrchestratorToolkit.tools.t3_thread_wait,
    ]) {
      const schema = Tool.getJsonSchema(tool) as {
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: ReadonlyArray<string>;
      };
      assert.include(JSON.stringify(schema.properties?.environmentId), "t3_environment_list");
      assert.notInclude(schema.required ?? [], "environmentId");
      assert.include(tool.description ?? "", "another connected environment");
    }
    // Batch creation inherits the caller's checkout, so it must not grow a selector.
    const batch = Tool.getJsonSchema(CreateThreadsTool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    assert.notProperty(batch.properties ?? {}, "environmentId");
    assert.include(CreateThreadsTool.description ?? "", "t3_thread_launch once per thread");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch changes");
  });
});
