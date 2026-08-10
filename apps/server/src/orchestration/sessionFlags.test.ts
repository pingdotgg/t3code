import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CodexSessionFlags,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-session-flags");

const sessionFlags: CodexSessionFlags = {
  version: 1,
  provider: "codex",
  config: {
    "features.hooks": true,
    bypass_hook_trust: true,
    "hooks.SessionStart": [
      { matcher: "startup", hooks: [{ type: "command", command: "gc hook session-start" }] },
    ],
    "hooks.PreCompact": [
      { matcher: "", hooks: [{ type: "command", command: "gc hook pre-compact" }] },
    ],
    "hooks.UserPromptSubmit": [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "gc hook nudge" },
          { type: "command", command: "gc hook mail" },
        ],
      },
    ],
  },
};

const seedProjectCreated = (): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("evt-project-session-flags"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("cmd-project-session-flags"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-project-session-flags"),
  metadata: {},
  payload: {
    projectId,
    title: "Session flags",
    workspaceRoot: "/tmp/session-flags",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

it.layer(NodeServices.layer)("Codex session flags orchestration", (it) => {
  it.effect("persists session flags from thread.create into the projected thread", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated());
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-session-flags"),
          threadId: ThreadId.make("thread-session-flags"),
          projectId,
          title: "Generated hooks",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          sessionFlags,
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.created");
      expect((event.payload as { sessionFlags?: unknown }).sessionFlags).toEqual(sessionFlags);

      const projected = yield* projectEvent(readModel, { ...event, sequence: 2 });
      expect(projected.threads[0]?.sessionFlags).toEqual(sessionFlags);
    }),
  );

  it.effect("keeps session flags absent for ordinary threads", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated());
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-ordinary"),
          threadId: ThreadId.make("thread-ordinary"),
          projectId,
          title: "Ordinary thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect("sessionFlags" in (event.payload as object)).toBe(false);

      const projected = yield* projectEvent(readModel, { ...event, sequence: 2 });
      expect("sessionFlags" in (projected.threads[0] as object)).toBe(false);
    }),
  );
});
