import { expect, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadManagementSendInput } from "../orchestration-v2/ThreadManagementService.ts";
import { delegateVoiceRequest, type VoiceDelegationThreads } from "./voiceDelegation.ts";

const THREAD_ID = ThreadId.make("thread-voice");
const RUN_ID = RunId.make("run-voice");

const makeShell = (overrides: Record<string, unknown> = {}): OrchestrationV2ThreadShell =>
  ({
    id: THREAD_ID,
    projectId: "project-voice",
    archivedAt: null,
    activeRunId: null,
    lastError: null,
    modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const makeRun = (status: OrchestrationV2Run["status"]): OrchestrationV2Run =>
  ({ id: RUN_ID, threadId: THREAD_ID, status }) as unknown as OrchestrationV2Run;

const assistant = (
  text: string,
  runId: RunId | null = RUN_ID,
  id = `message-${text.length}`,
): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(id),
    threadId: THREAD_ID,
    runId,
    role: "assistant",
    text,
  }) as unknown as OrchestrationV2ConversationMessage;

const makeThreads = (input: {
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly finalShell?: OrchestrationV2ThreadShell;
  readonly finalStatus?: OrchestrationV2Run["status"];
  readonly timedOut?: boolean;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly onSend?: (input: ThreadManagementSendInput) => void;
}): VoiceDelegationThreads => {
  let reads = 0;
  return {
    getThreadShell: () =>
      Effect.sync(() => {
        reads += 1;
        return reads > 1 && input.finalShell !== undefined ? input.finalShell : input.shell;
      }),
    sendToThread: (send) =>
      Effect.sync(() => {
        input.onSend?.(send);
        return { run: makeRun("running") } as never;
      }),
    waitForThread: () =>
      Effect.succeed({
        threadId: THREAD_ID,
        run: makeRun(input.finalStatus ?? "completed"),
        timedOut: input.timedOut ?? false,
      }),
    getThreadRecords: (_threadId, _fields, filter) =>
      Effect.succeed({
        thread: {},
        messages: (input.messages ?? []).filter(
          (message) =>
            filter?.messageRunIds === undefined ||
            (message.runId !== null && filter.messageRunIds.includes(message.runId)),
        ),
      } as never),
  };
};

it.effect("runs the spoken request as a turn and answers with the agent's text", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementSendInput> = [];
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        messages: [assistant("17 times 23 is 391.")],
        onSend: (send) => sent.push(send),
      }),
      THREAD_ID,
      "What is seventeen times twenty-three?",
    );
    expect(answer).toBe("17 times 23 is 391.");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("What is seventeen times twenty-three?");
    // The task's own model selection decides who answers — never the voice layer.
    expect(sent[0]?.modelSelection).toBeUndefined();
  }),
);

it.effect("ignores messages from a run the request did not start", () =>
  Effect.gen(function* () {
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        messages: [
          assistant("leftover from the previous turn", RunId.make("run-earlier"), "m-1"),
          assistant("391", RUN_ID, "m-2"),
        ],
      }),
      THREAD_ID,
      "What is seventeen times twenty-three?",
    );
    expect(answer).toBe("391");
  }),
);

it.effect("joins every assistant message of the run and skips empty ones", () =>
  Effect.gen(function* () {
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        messages: [
          assistant("Checking.", RUN_ID, "m-1"),
          assistant("", RUN_ID, "m-2"),
          assistant("Done.", RUN_ID, "m-3"),
        ],
      }),
      THREAD_ID,
      "Anything",
    );
    expect(answer).toBe("Checking.\n\nDone.");
  }),
);

it.effect("surfaces a failed turn instead of speaking a made-up answer", () =>
  Effect.gen(function* () {
    const failure = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        finalShell: makeShell({ lastError: "Claude usage limit reached" }),
        finalStatus: "failed",
      }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(failure.message).toBe("Claude usage limit reached");
  }),
);

it.effect("refuses to queue a second request while the agent is still working", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementSendInput> = [];
    const failure = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell({ activeRunId: RunId.make("run-busy") }),
        onSend: (send) => sent.push(send),
      }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(failure.message).toContain("already working");
    expect(sent).toHaveLength(0);
  }),
);

it.effect("refuses to speak into an archived or missing task", () =>
  Effect.gen(function* () {
    const missing = yield* delegateVoiceRequest(
      makeThreads({ shell: null }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(missing._tag).toBe("VoiceApiError");
    expect(missing.message).toContain("active T3 Code task");

    const archived = yield* delegateVoiceRequest(
      makeThreads({ shell: makeShell({ archivedAt: "2026-01-01T00:00:00.000Z" }) }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(archived.message).toContain("active T3 Code task");
  }),
);
