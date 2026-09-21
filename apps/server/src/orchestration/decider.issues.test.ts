import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const issue = (number: number): ThreadIssueLink => ({
  provider: "github",
  repository: "t3tools/t3code",
  number,
  url: `https://github.com/t3tools/t3code/issues/${number}`,
  title: `Issue ${number}`,
});

const model = (): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: projectId,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      issues: [],
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: now,
});

it.layer(NodeServices.layer)("thread issue links", (it) => {
  it.effect("keeps sequential links, replays them, and unlinks only the selected issue", () =>
    Effect.gen(function* () {
      let current = model();
      const events: OrchestrationEvent[] = [];
      for (const number of [10, 11]) {
        const command = yield* decodeCommand({
          type: "thread.meta.update",
          commandId: `link-${number}`,
          threadId,
          issueLink: issue(number),
        });
        const decided = yield* decideOrchestrationCommand({ readModel: current, command });
        expect(Array.isArray(decided)).toBe(false);
        if (Array.isArray(decided)) return;
        const event = { ...decided, sequence: number } as OrchestrationEvent;
        events.push(event);
        current = yield* projectEvent(current, event);
      }
      expect(current.threads[0]?.issues?.map((link) => link.number)).toEqual([10, 11]);

      let replayed = model();
      for (const event of events) replayed = yield* projectEvent(replayed, event);
      expect(replayed.threads[0]?.issues).toEqual(current.threads[0]?.issues);
      replayed = yield* projectEvent(replayed, {
        ...events[1]!,
        sequence: 13,
        payload: { threadId, title: "Renamed", updatedAt: now },
      } as OrchestrationEvent);
      expect(replayed.threads[0]?.issues).toEqual([issue(10), issue(11)]);

      const command = yield* decodeCommand({
        type: "thread.meta.update",
        commandId: "unlink-10",
        threadId,
        issueUnlink: { provider: "github", repository: "T3Tools/T3Code", number: 10 },
      });
      const decided = yield* decideOrchestrationCommand({ readModel: current, command });
      expect(Array.isArray(decided)).toBe(false);
      if (Array.isArray(decided)) return;
      current = yield* projectEvent(current, { ...decided, sequence: 12 } as OrchestrationEvent);
      expect(current.threads[0]?.issues).toEqual([issue(11)]);
    }),
  );

  it.effect("rejects a 101st issue link", () =>
    Effect.gen(function* () {
      const current = model();
      const full = {
        ...current,
        threads: [
          {
            ...current.threads[0]!,
            issues: Array.from({ length: 100 }, (_, index) => issue(index + 1)),
          },
        ],
      };
      const command = yield* decodeCommand({
        type: "thread.meta.update",
        commandId: "link-101",
        threadId,
        issueLink: issue(101),
      });
      const error = yield* decideOrchestrationCommand({ readModel: full, command }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: expect.stringContaining("100 linked issues"),
      });
    }),
  );

  it.effect("rejects duplicate links and missing unlinks", () =>
    Effect.gen(function* () {
      const current = model();
      const linked = { ...current, threads: [{ ...current.threads[0]!, issues: [issue(7)] }] };
      for (const [commandId, change, detail] of [
        ["duplicate", { issueLink: issue(7) }, "already linked"],
        ["missing", { issueUnlink: issue(8) }, "not linked"],
      ] as const) {
        const command = yield* decodeCommand({
          type: "thread.meta.update",
          commandId,
          threadId,
          ...change,
        });
        const error = yield* decideOrchestrationCommand({ readModel: linked, command }).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          detail: expect.stringContaining(detail),
        });
      }
    }),
  );
});
