import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  gitActionFailureMessage,
  sendGitActionFailureToAgent,
} from "./sendGitActionFailureToAgent.ts";

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const commandId = Effect.succeed(CommandId.make("server:git-action-failure:test"));

const thread: PullRequestTestThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
};

const recordingDispatch = Effect.fn("recordingDispatch")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  return { commands, dispatch };
});

const layerDependenciesFor = (
  dispatch: Orchestrator.OrchestratorV2Shape["dispatch"],
  options?: {
    readonly threadShell?: PullRequestTestThread | null;
    readonly sendGitActionFailuresToAgent?: boolean;
  },
) => {
  const threadShell = options?.threadShell === undefined ? thread : options.threadShell;
  return Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () =>
        Effect.succeed(threadShell === null ? null : v2PullRequestThread(threadShell)),
      dispatch,
    }),
    ServerSettings.ServerSettingsService.layerTest({
      sendGitActionFailuresToAgent: options?.sendGitActionFailuresToAgent ?? true,
    }),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
  );
};

describe("gitActionFailureMessage", () => {
  it("names the action, phase, and error detail", () => {
    expect(
      gitActionFailureMessage({
        action: "commit_push_pr",
        phase: "push",
        detail: "Permission denied (publickey).",
      }),
    ).toEqual({
      text: [
        "The Commit, push & PR action failed while pushing:",
        "",
        "Permission denied (publickey).",
        "",
        "Fix the issue and retry the action.",
      ].join("\n"),
      notification: {
        source: { kind: "system" },
        outcome: "failed",
        summary: "Commit, push & PR failed",
      },
    });
  });

  it("omits the phase clause when none was recorded", () => {
    expect(
      gitActionFailureMessage({
        action: "commit",
        phase: null,
        detail: "  nothing to commit  ",
      }).text,
    ).toBe(
      [
        "The Commit action failed:",
        "",
        "nothing to commit",
        "",
        "Fix the issue and retry the action.",
      ].join("\n"),
    );
  });
});

describe("sendGitActionFailureToAgent", () => {
  it.effect("dispatches a queued wake when the Labs setting is on", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      yield* sendGitActionFailureToAgent({
        threadId: THREAD_ID,
        action: "push",
        phase: "push",
        detail: "rejected (non-fast-forward)",
        commandId,
      }).pipe(Effect.provide(layerDependenciesFor(dispatch)));

      const recorded = yield* Ref.get(commands);
      expect(recorded).toHaveLength(1);
      const command = recorded[0];
      expect(command).toMatchObject({
        type: "message.dispatch",
        commandId: "server:git-action-failure:test",
        threadId: THREAD_ID,
        text: gitActionFailureMessage({
          action: "push",
          phase: "push",
          detail: "rejected (non-fast-forward)",
        }).text,
        notification: {
          source: { kind: "system" },
          outcome: "failed",
          summary: "Push failed",
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      expect(command?.type === "message.dispatch" && command.messageId).toMatch(
        /^message:git-action-failure:/,
      );
    }),
  );

  it.effect("does nothing when the Labs setting is off", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      yield* sendGitActionFailureToAgent({
        threadId: THREAD_ID,
        action: "commit",
        phase: "commit",
        detail: "hook failed",
        commandId,
      }).pipe(
        Effect.provide(layerDependenciesFor(dispatch, { sendGitActionFailuresToAgent: false })),
      );

      expect(yield* Ref.get(commands)).toEqual([]);
    }),
  );

  it.effect("does nothing when the thread is missing", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      yield* sendGitActionFailureToAgent({
        threadId: THREAD_ID,
        action: "create_pr",
        phase: "pr",
        detail: "gh not authenticated",
        commandId,
      }).pipe(Effect.provide(layerDependenciesFor(dispatch, { threadShell: null })));

      expect(yield* Ref.get(commands)).toEqual([]);
    }),
  );

  it.effect(
    "swallows a dispatch failure so the stacked-action error still reaches the client",
    () =>
      Effect.gen(function* () {
        const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = () =>
          Effect.die("dispatch unavailable");
        yield* sendGitActionFailureToAgent({
          threadId: THREAD_ID,
          action: "commit_push",
          phase: null,
          detail: "index.lock",
          commandId,
        }).pipe(Effect.provide(layerDependenciesFor(dispatch)));
      }),
  );
});
