import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  PostHogCloudRunId,
  PostHogCloudTaskId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type PostHogCloudRun,
  type PostHogCloudTask,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import { PostHogClient } from "../../posthog/PostHogClient.ts";
import { makePostHogCloudAdapter } from "./PostHogCloudAdapter.ts";

const timestamp = "2026-08-27T12:00:00.000Z";
const taskId = PostHogCloudTaskId.make("10000000-0000-4000-8000-000000000001");
const runOneId = PostHogCloudRunId.make("20000000-0000-4000-8000-000000000001");
const runTwoId = PostHogCloudRunId.make("20000000-0000-4000-8000-000000000002");

function cloudRun(id: typeof runOneId, status: PostHogCloudRun["status"]): PostHogCloudRun {
  return {
    id,
    task: taskId,
    status,
    artifacts: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function cloudTask(latestRun: PostHogCloudRun | null): PostHogCloudTask {
  return {
    id: taskId,
    title: "Cloud task",
    description: "",
    repository: "posthog/t3code",
    repositories: ["posthog/t3code"],
    latest_run: latestRun,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("PostHogCloudAdapter", () => {
  it.effect("routes turns, attachments, interruption, and run shutdown", () => {
    const runCalls: Array<Parameters<PostHogClient["Service"]["runCloudTask"]>[0]> = [];
    const commandCalls: Array<Parameters<PostHogClient["Service"]["commandCloudRun"]>[0]> = [];
    const cancelCalls: Array<Parameters<PostHogClient["Service"]["cancelCloudRun"]>[0]> = [];
    const uploadCalls: Array<Parameters<PostHogClient["Service"]["uploadCloudRunArtifacts"]>[0]> =
      [];
    const createCalls: Array<Parameters<PostHogClient["Service"]["createCloudTask"]>[0]> = [];
    let currentRun = cloudRun(runOneId, "in_progress");
    let streamCalls = 0;

    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogClient.of({
      listReports: unused,
      listReportArtefacts: unused,
      listReportSignals: unused,
      setReportState: unused,
      getCurrentUser: unused,
      setReviewers: unused,
      listCloudModels: unused,
      createCloudTask: (input) =>
        Effect.sync(() => {
          createCalls.push(input);
          return cloudTask(null);
        }),
      runCloudTask: (input) =>
        Effect.sync(() => {
          runCalls.push(input);
          const id = runCalls.length === 1 ? runOneId : runTwoId;
          currentRun = cloudRun(id, "in_progress");
          return cloudTask(currentRun);
        }),
      getCloudRun: () => Effect.sync(() => currentRun),
      commandCloudRun: (input) =>
        Effect.sync(() => {
          commandCalls.push(input);
          return {};
        }),
      cancelCloudRun: (input) =>
        Effect.sync(() => {
          cancelCalls.push(input);
          currentRun = cloudRun(input.runId, "cancelled");
          return currentRun;
        }),
      uploadCloudRunArtifacts: (input) =>
        Effect.sync(() => {
          uploadCalls.push(input);
          return [{ id: `artifact-${uploadCalls.length}`, name: input.artifacts[0]?.name }];
        }),
      readCloudRunLogs: () => Effect.succeed(""),
      streamCloudRun: () =>
        Effect.succeed(
          streamCalls++ === 0
            ? Stream.make(
                {
                  event: "message",
                  data: {
                    type: "permission_request",
                    requestId: "question-1",
                    toolCall: {
                      toolCallId: "tool-1",
                      title: "Choose a framework",
                      _meta: {
                        codeToolKind: "question",
                        questions: [
                          {
                            question: "Which framework?",
                            header: "Framework",
                            options: [{ label: "React", description: "Use React" }],
                          },
                        ],
                      },
                    },
                    options: [{ optionId: "option_0", kind: "allow_once", name: "React" }],
                  },
                },
                {
                  event: "message",
                  data: {
                    type: "notification",
                    notification: {
                      method: "session/update",
                      params: {
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "Hello" },
                        },
                      },
                    },
                  },
                },
                {
                  event: "message",
                  data: {
                    type: "notification",
                    notification: {
                      method: "session/update",
                      params: {
                        update: {
                          sessionUpdate: "agent_message",
                          content: { type: "text", text: "Hello" },
                        },
                      },
                    },
                  },
                },
                {
                  event: "message",
                  data: {
                    type: "notification",
                    notification: { method: "_posthog/turn_complete", params: {} },
                  },
                },
              )
            : Stream.never,
        ),
    });
    const fileSystem = FileSystem.makeNoop({
      readFile: () => Effect.succeed(new TextEncoder().encode("image bytes")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("cloud-thread");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("posthogCloud"),
          model: "claude:claude-sonnet-4-5",
        };
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: modelSelection.instanceId,
          posthog,
          fileSystem,
        });

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          repository: "posthog/t3code",
          reportId: "report-1",
          runtimeMode: "full-access",
          modelSelection,
        });

        const attachment = {
          type: "image" as const,
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 11,
        };
        const firstTurnEvents: ProviderRuntimeEvent[] = [];
        const firstTurnCompleted = yield* Deferred.make<void>();
        const firstTurnEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              firstTurnEvents.push(event);
            }).pipe(
              Effect.andThen(
                event.type === "turn.completed"
                  ? Deferred.succeed(firstTurnCompleted, undefined)
                  : Effect.void,
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({
          threadId,
          input: "Inspect this screenshot",
          attachments: [attachment],
          resolvedAttachments: [{ ...attachment, path: "/attachments/screenshot.png" }],
          modelSelection,
        });
        yield* Deferred.await(firstTurnCompleted);
        yield* Fiber.interrupt(firstTurnEventsFiber);
        assert.deepStrictEqual(
          firstTurnEvents.map((event) => event.type),
          [
            "turn.started",
            "task.progress",
            "user-input.requested",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        const userInput = firstTurnEvents.find((event) => event.type === "user-input.requested");
        assert.deepStrictEqual(userInput?.payload.questions, [
          {
            id: "Which framework?",
            header: "Framework",
            question: "Which framework?",
            options: [{ label: "React", description: "Use React" }],
            multiSelect: false,
          },
        ]);
        const deltas = firstTurnEvents
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta);
        assert.deepStrictEqual(deltas, ["Hello"]);
        yield* adapter.sendTurn({ threadId, input: "Keep going", attachments: [], modelSelection });

        currentRun = cloudRun(runOneId, "completed");
        yield* adapter.sendTurn({
          threadId,
          input: "Resume with this screenshot",
          attachments: [attachment],
          resolvedAttachments: [{ ...attachment, id: "image-2", path: "/attachments/next.png" }],
          modelSelection,
        });
        yield* adapter.interruptTurn(threadId);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId: ThreadId.make("background-cloud-thread"),
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          modelSelection,
          runtimePayload: { schemaVersion: 1, taskId, repository: "posthog/t3code" },
          resumeCursor: { schemaVersion: 1, runId: runTwoId },
        });
        yield* adapter.stopAll();

        assert.deepStrictEqual(createCalls, [
          {
            title: "Inspect this screenshot",
            description: "",
            repository: "posthog/t3code",
            signalReportId: "report-1",
          },
        ]);
        assert.equal(runCalls.length, 2);
        assert.equal(runCalls[0]?.message, "");
        assert.equal(runCalls[0]?.resumeFromRunId, undefined);
        assert.equal(runCalls[1]?.message, "");
        assert.equal(runCalls[1]?.resumeFromRunId, runOneId);
        assert.deepStrictEqual(
          uploadCalls.map((call) => ({ runId: call.runId, base64: call.artifacts[0]?.base64 })),
          [
            { runId: runOneId, base64: "aW1hZ2UgYnl0ZXM=" },
            { runId: runTwoId, base64: "aW1hZ2UgYnl0ZXM=" },
          ],
        );
        assert.deepStrictEqual(
          commandCalls.map((call) => ({
            runId: call.runId,
            method: call.method,
            params: call.params,
          })),
          [
            {
              runId: runOneId,
              method: "user_message",
              params: {
                content: "Inspect this screenshot",
                artifact_ids: ["artifact-1"],
                steer: false,
              },
            },
            {
              runId: runOneId,
              method: "user_message",
              params: { content: "Keep going", steer: false },
            },
            {
              runId: runTwoId,
              method: "user_message",
              params: {
                content: "Resume with this screenshot",
                artifact_ids: ["artifact-2"],
                steer: false,
              },
            },
            { runId: runTwoId, method: "cancel", params: undefined },
          ],
        );
        assert.deepStrictEqual(cancelCalls, [{ taskId, runId: runTwoId }]);

        const sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.status, "closed");
        assert.deepStrictEqual(sessions[0]?.runtimePayload, {
          schemaVersion: 1,
          taskId,
          repository: "posthog/t3code",
        });
        assert.deepStrictEqual(sessions[0]?.resumeCursor, {
          schemaVersion: 1,
          runId: runTwoId,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });
});
