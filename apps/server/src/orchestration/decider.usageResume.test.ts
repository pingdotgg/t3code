import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch, so a
// window that still has time left must sit after 1970-01-01T00:00:00.000Z.
const RESETS_AT = "1970-01-02T09:00:00.000Z";

function makeThread(input: {
  readonly sessionStatus?: OrchestrationThread["session"] extends null
    ? never
    : NonNullable<OrchestrationThread["session"]>["status"];
  readonly lastErrorKind?: "usage_limit";
  readonly lastErrorResetsAt?: string | null;
  readonly usageLimitResumeAt?: string | null;
}): OrchestrationThread {
  const sessionError = input.sessionStatus === "error";
  return {
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
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    usageLimitResumeAt: input.usageLimitResumeAt ?? null,
    session: input.sessionStatus
      ? {
          threadId: ThreadId.make("thread-1"),
          status: input.sessionStatus,
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: sessionError ? "Claude usage limit reached." : null,
          ...(input.lastErrorKind !== undefined ? { lastErrorKind: input.lastErrorKind } : {}),
          ...(input.lastErrorResetsAt !== undefined
            ? { lastErrorResetsAt: input.lastErrorResetsAt }
            : {}),
          updatedAt: NOW,
        }
      : null,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [thread],
    updatedAt: NOW,
  };
}

const armCommand = {
  type: "thread.usage-resume.arm" as const,
  commandId: CommandId.make("cmd-arm"),
  threadId: ThreadId.make("thread-1"),
  resumeAt: RESETS_AT,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("usage-limit resume decider", (it) => {
  it.effect("arms a resume for a thread parked on a usage-limit failure", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: armCommand,
        readModel: makeReadModel(
          makeThread({
            sessionStatus: "error",
            lastErrorKind: "usage_limit",
            lastErrorResetsAt: RESETS_AT,
          }),
        ),
      });
      expect(event).toMatchObject({ type: "thread.usage-resume-armed" });
    }),
  );

  it.effect("rejects arming a thread with no usage-limit failure", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: armCommand,
        readModel: makeReadModel(makeThread({ sessionStatus: "ready" })),
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );

  it.effect("rejects arming a failed thread whose error is not a usage limit", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: armCommand,
        readModel: makeReadModel(makeThread({ sessionStatus: "error" })),
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );

  it.effect("rejects a resume time that does not match the failure window", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: { ...armCommand, resumeAt: "1970-01-03T09:00:00.000Z" },
        readModel: makeReadModel(
          makeThread({
            sessionStatus: "error",
            lastErrorKind: "usage_limit",
            lastErrorResetsAt: RESETS_AT,
          }),
        ),
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );

  it.effect("judges the window against the server clock, not the command stamp", () =>
    Effect.gen(function* () {
      // RESETS_AT is in the future relative to the test clock (epoch), but a
      // client with a stale command stamp must not sneak a past window by.
      const error = yield* decideOrchestrationCommand({
        command: { ...armCommand, resumeAt: "1969-12-31T00:00:00.000Z", createdAt: NOW },
        readModel: makeReadModel(
          makeThread({
            sessionStatus: "error",
            lastErrorKind: "usage_limit",
            lastErrorResetsAt: "1969-12-31T00:00:00.000Z",
          }),
        ),
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
    }),
  );

  it.effect("disarms on a user turn start", () =>
    Effect.gen(function* () {
      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "take over manually",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel(
          makeThread({
            sessionStatus: "error",
            lastErrorKind: "usage_limit",
            lastErrorResetsAt: RESETS_AT,
            usageLimitResumeAt: RESETS_AT,
          }),
        ),
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((event) => event.type)).toContain("thread.usage-resume-disarmed");
    }),
  );
});
