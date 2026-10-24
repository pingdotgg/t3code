import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ThreadForkNote from "./ThreadForkNoteService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const sourceThreadId = ThreadId.make("source");
const projectId = ProjectId.make("project");
const runId = RunId.make("note-run");

function harness(input: {
  readonly runStatus: OrchestrationV2Run["status"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "runId" | "text">
  >;
}) {
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const sent: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        id: sourceThreadId,
        projectId,
        title: "Fix login",
        deletedAt: null,
      } as OrchestrationV2ThreadShell),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length } as never;
      }),
    sendToThread: (send) =>
      Effect.sync(() => {
        sent.push({ threadId: send.threadId, text: send.text });
        return { run: { id: runId } } as ThreadManagement.ThreadManagementSendResult;
      }),
    waitForThread: (wait) =>
      Effect.succeed({
        threadId: wait.threadId,
        run: { id: runId, status: input.runStatus } as OrchestrationV2Run,
        timedOut: false,
      }),
    getThreadRecords: (threadId) =>
      Effect.succeed(
        (threadId === sourceThreadId
          ? {
              runs: [
                { id: RunId.make("stopped-run"), ordinal: 2, status: "interrupted" },
                { id: RunId.make("older-run"), ordinal: 1, status: "completed" },
              ],
            }
          : {
              messages: input.messages.map((message, index) => ({
                ...message,
                id: MessageId.make(`message-${index}`),
              })),
            }) as never,
      ),
  });
  const layer = ThreadForkNote.layer.pipe(Layer.provide(Layer.merge(threads, NodeCrypto.layer)));
  return { commands, sent, layer };
}

const write = ThreadForkNote.ThreadForkNoteService.use((service) =>
  service.write({ threadId: sourceThreadId, targetLabel: "Box" }),
);

describe("ThreadForkNoteService", () => {
  it.effect("returns the scratch fork's final answer and deletes the scratch fork", () => {
    const { commands, sent, layer } = harness({
      runStatus: "completed",
      messages: [
        { role: "user", runId, text: "prompt" },
        { role: "assistant", runId, text: "Looking back over the work." },
        { role: "assistant", runId, text: "  ## Goal\nShip login.\n" },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* write;
      assert.strictEqual(result.note, "## Goal\nShip login.");

      const [fork, remove] = commands;
      assert.strictEqual(fork?.type, "thread.fork");
      if (fork?.type !== "thread.fork") return;
      assert.strictEqual(fork.sourceThreadId, sourceThreadId);
      // A stopped last turn is still part of the conversation the note covers.
      assert.deepStrictEqual(fork.sourcePoint, { type: "run", runId: RunId.make("stopped-run") });
      assert.deepStrictEqual(
        sent.map((entry) => entry.threadId),
        [fork.targetThreadId],
      );
      assert.include(sent[0]?.text, '"Box"');
      assert.strictEqual(remove?.type, "thread.delete");
      assert.strictEqual(remove?.type === "thread.delete" && remove.threadId, fork.targetThreadId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still deletes the scratch fork when its turn fails", () => {
    const { commands, layer } = harness({ runStatus: "failed", messages: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(write);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.fork", "thread.delete"],
      );
    }).pipe(Effect.provide(layer));
  });
});
