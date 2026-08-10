import { CommandId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const projectlessCreate = (workspaceRoot: string | null) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`cmd-projectless-${workspaceRoot ?? "missing"}`),
  threadId: ThreadId.make(`thread-projectless-${workspaceRoot ?? "missing"}`),
  projectId: null,
  workspaceRoot,
  title: "No project",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: now,
});

it.layer(NodeServices.layer)("decider projectless threads", (it) => {
  it.effect("creates a thread with an explicit environment workspace root", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: projectlessCreate("/tmp/environment-root"),
        readModel: createEmptyReadModel(now),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.created");
      expect(event.payload.projectId).toBeNull();
      expect(event.payload.workspaceRoot).toBe("/tmp/environment-root");
    }),
  );

  it.effect("rejects a thread with neither a project nor workspace root", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: projectlessCreate(null),
          readModel: createEmptyReadModel(now),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});
