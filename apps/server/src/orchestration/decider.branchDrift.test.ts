import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const checkoutDirectories = {
  target: "/shared",
  byThread: new Map([
    [ThreadId.make("thread-1"), "/shared"],
    [ThreadId.make("sibling"), "/shared"],
  ]),
};

function makeReadModel(): OrchestrationReadModel {
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
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        pullRequests: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("worktree branch drift guard", (it) => {
  for (const status of ["starting", "running", "ready"] as const) {
    it.effect(
      `rejects drift when a sibling becomes ${status} with an active turn before dispatch`,
      () =>
        Effect.gen(function* () {
          const base = makeReadModel();
          const thread = { ...base.threads[0]!, branch: "original", worktreePath: "/shared" };
          const command = {
            type: "thread.meta.update" as const,
            commandId: CommandId.make("drift"),
            threadId: thread.id,
            branch: "drifted",
            expectedBranch: "original",
            requireIdleWorktreePath: "/shared",
          };
          const sibling = {
            ...thread,
            id: ThreadId.make("sibling"),
            branch: "sibling-branch",
            worktreePath: "/shared-alias",
            session: {
              threadId: ThreadId.make("sibling"),
              status,
              providerName: "codex" as const,
              runtimeMode: "full-access" as const,
              activeTurnId: status === "ready" ? TurnId.make("active") : null,
              lastError: null,
              updatedAt: NOW,
            },
          };
          const event = yield* decideOrchestrationCommand({
            checkoutDirectories,
            command,
            readModel: { ...base, threads: [thread, sibling] },
          });
          const events = Array.isArray(event) ? event : [event];
          expect(events[0]).toMatchObject({
            type: "thread.meta-updated",
            payload: { branch: "original", updatedAt: NOW },
          });

          const idleEvent = yield* decideOrchestrationCommand({
            checkoutDirectories,
            command,
            readModel: { ...base, threads: [thread, { ...sibling, session: null }] },
          });
          const idleEvents = Array.isArray(idleEvent) ? idleEvent : [idleEvent];
          expect(idleEvents[0]).toMatchObject({
            type: "thread.meta-updated",
            payload: { branch: "drifted", updatedAt: "1970-01-01T00:00:00.000Z" },
          });
        }),
    );
  }

  for (const queued of [true, false]) {
    it.effect(
      `${queued ? "rejects" : "allows"} drift for a sibling with a ${queued ? "queued" : "stale"} message and no session`,
      () =>
        Effect.gen(function* () {
          const base = makeReadModel();
          const thread = { ...base.threads[0]!, branch: "original", worktreePath: "/shared" };
          // Effect's test clock starts at the epoch. Stale messages exceed the queue grace period.
          const createdAt = queued ? "1970-01-01T00:00:00.000Z" : "1969-12-31T23:50:00.000Z";
          const sibling = {
            ...thread,
            id: ThreadId.make("sibling"),
            worktreePath: "/shared/.",
            messages: [
              {
                id: MessageId.make("queued-message"),
                role: "user" as const,
                text: "Continue",
                turnId: null,
                streaming: false,
                createdAt,
                updatedAt: createdAt,
              },
            ],
          };
          const event = yield* decideOrchestrationCommand({
            checkoutDirectories,
            command: {
              type: "thread.meta.update",
              commandId: CommandId.make("queued-drift"),
              threadId: thread.id,
              branch: "drifted",
              expectedBranch: "original",
              requireIdleWorktreePath: "/shared",
            },
            readModel: { ...base, threads: [thread, sibling] },
          });
          const events = Array.isArray(event) ? event : [event];
          expect(events[0]).toMatchObject({
            type: "thread.meta-updated",
            payload: { branch: queued ? "original" : "drifted" },
          });
        }),
    );
  }

  it.effect("rejects drift after the thread moves to another checkout", () =>
    Effect.gen(function* () {
      const base = makeReadModel();
      const thread = { ...base.threads[0]!, branch: "original", worktreePath: "/new-checkout" };
      const event = yield* decideOrchestrationCommand({
        checkoutDirectories,
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("drift-moved"),
          threadId: thread.id,
          branch: "drifted",
          expectedBranch: "original",
          requireIdleWorktreePath: "/shared",
        },
        readModel: { ...base, threads: [thread] },
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]).toMatchObject({
        type: "thread.meta-updated",
        payload: { branch: "original" },
      });
    }),
  );

  it.effect("still timestamps an explicit title update when branch adoption is blocked", () =>
    Effect.gen(function* () {
      const base = makeReadModel();
      const thread = { ...base.threads[0]!, branch: "original", worktreePath: "/new-checkout" };
      const event = yield* decideOrchestrationCommand({
        checkoutDirectories,
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("drift-with-title"),
          threadId: thread.id,
          title: "Renamed",
          branch: "drifted",
          requireIdleWorktreePath: "/shared",
        },
        readModel: { ...base, threads: [thread] },
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]).toMatchObject({
        type: "thread.meta-updated",
        payload: { branch: "original", title: "Renamed", updatedAt: "1970-01-01T00:00:00.000Z" },
      });
    }),
  );
});
