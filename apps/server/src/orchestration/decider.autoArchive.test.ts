import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SETTLED_AT = "2025-11-01T00:00:00.000Z";

function makeReadModel(input: {
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: input.settledOverride,
        settledAt: input.settledAt,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const autoArchive = (readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.auto-archive",
      commandId: CommandId.make("cmd-auto-archive"),
      threadId: ThreadId.make("thread-1"),
      settledAt: SETTLED_AT,
    },
    readModel,
  });

it.layer(NodeServices.layer)("thread.auto-archive decider", (it) => {
  it.effect("archives a thread that is still settled at the observed time", () =>
    Effect.gen(function* () {
      const event = yield* autoArchive(
        makeReadModel({ settledOverride: "settled", settledAt: SETTLED_AT }),
      );
      const [archived] = Array.isArray(event) ? event : [event];
      expect(archived?.type).toBe("thread.archived");
    }),
  );

  it.effect.each([
    ["un-settled", { settledOverride: "active", settledAt: null }],
    ["cleared by activity", { settledOverride: null, settledAt: null }],
    ["settled again later", { settledOverride: "settled", settledAt: NOW }],
    ["already archived", { settledOverride: "settled", settledAt: SETTLED_AT, archivedAt: NOW }],
  ] as const)("rejects a thread %s since the snapshot", ([, state]) =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(autoArchive(makeReadModel(state)));
      expect(result._tag).toBe("Failure");
    }),
  );
});
