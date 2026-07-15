import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { WorkflowDefinition } from "../workflows/WorkflowSchema.ts";

const decodeWorkflow = Schema.decodeUnknownEffect(WorkflowDefinition);

describe("WorkflowSchema", () => {
  it.effect("decodes a complete workflow definition", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflow({
        name: "test-workflow",
        description: "Test workflow",
        version: "1.0.0",
        phases: [
          {
            id: "phase1",
            title: "Phase 1",
            execution: "sequential",
            tasks: [
              {
                id: "task1",
                type: "spawn",
                provider: ProviderInstanceId.make("codex"),
                model: "gpt-4o",
                prompt: "Test task",
              },
              {
                id: "task2",
                type: "wait",
                dependencies: ["task1"],
              },
            ],
          },
        ],
      });

      expect(decoded.phases[0]?.tasks.map((task) => task.type)).toEqual(["spawn", "wait"]);
    }),
  );

  it.effect.each([
    {
      label: "spawn without provider",
      task: { id: "task1", type: "spawn", prompt: "Test task" },
    },
    {
      label: "spawn without prompt",
      task: {
        id: "task1",
        type: "spawn",
        provider: ProviderInstanceId.make("codex"),
      },
    },
    {
      label: "wait without dependencies",
      task: { id: "task1", type: "wait" },
    },
    {
      label: "send without prompt",
      task: { id: "task1", type: "send", dependencies: ["spawn"] },
    },
  ])("rejects $label", ({ task }) =>
    Effect.gen(function* () {
      const exit = yield* decodeWorkflow({
        name: "invalid-workflow",
        description: "Invalid workflow",
        version: "1.0.0",
        phases: [
          {
            id: "phase1",
            title: "Phase 1",
            execution: "sequential",
            tasks: [task],
          },
        ],
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
