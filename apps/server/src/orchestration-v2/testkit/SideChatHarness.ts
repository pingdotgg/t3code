import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2SideChatOutcome,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { SIDE_CHAT_OUTCOME_EXCERPT_HEADER } from "../sideChat/notes.ts";
import { makePromptRecordingAdapter } from "./PromptRecordingAdapter.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

/** What the scripted provider answers on every turn. */
export const SIDE_CHAT_HARNESS_REPLY =
  "Reply: an observation space is what the agent sees, a Box is a bounded vector, and reward shaping changes the reward.";

/**
 * One answer of the note or opening summary writer: text (or none), a failure, or a gate the test
 * releases.
 */
export type SideChatNoteScript =
  | { readonly text: string | null }
  | { readonly fail: string }
  | { readonly gate: Deferred.Deferred<string | null> };

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const LESSON_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "side-chat-model",
};

/** The line under `header` in a text writer's input, where it states the highlight. */
function lineAfter(prompt: string, header: string): string | undefined {
  const lines = prompt.split("\n");
  const index = lines.indexOf(header);
  return index === -1 ? undefined : lines[index + 1];
}

/** The highlight a note writer's input is about. */
const outcomeExcerpt = (prompt: string) => lineAfter(prompt, SIDE_CHAT_OUTCOME_EXCERPT_HEADER);

const runNoteScript = (script: SideChatNoteScript) =>
  "fail" in script
    ? Effect.fail(
        new TextGenerationError({ operation: "generateSideChatText", detail: script.fail }),
      )
    : "gate" in script
      ? Deferred.await(script.gate).pipe(Effect.map((text) => ({ text })))
      : Effect.succeed({ text: script.text });

/**
 * A lesson and its side chats on a scripted Codex provider that answers `SIDE_CHAT_HARNESS_REPLY`,
 * with scripted note and opening summary writers and the effect daemon running. Tests await events
 * instead of draining the worker, because a note may still be generating.
 */
export const makeSideChatHarness = Effect.fn("makeSideChatHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const provider = yield* makePromptRecordingAdapter({
    instanceId: LESSON_SELECTION.instanceId,
    driver: ProviderDriverKind.make("codex"),
    capabilities: CodexProviderCapabilitiesV2,
    cwd,
    replyText: SIDE_CHAT_HARNESS_REPLY,
  });

  const noteInputs: Array<string> = [];
  const noteScripts = new Map<string, Array<SideChatNoteScript>>();
  const noteRequests = new Map<string, Deferred.Deferred<void>>();
  const noteRequest = (excerpt: string): Deferred.Deferred<void> => {
    const existing = noteRequests.get(excerpt);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<void>();
    noteRequests.set(excerpt, created);
    return created;
  };

  const openingScripts = new Map<string, Array<SideChatNoteScript>>();

  const sideChatTextGeneration = Effect.fn("SideChatHarness.generateSideChatText")(function* (
    input: TextGeneration.SideChatTextGenerationInput,
  ) {
    if (input.kind === "opening_summary") {
      const scriptEntry = [...openingScripts.entries()].find(
        ([marker, scripts]) => scripts.length > 0 && input.prompt.includes(marker),
      );
      const script = scriptEntry?.[1].shift();
      return yield* runNoteScript(script ?? { text: null });
    }
    const excerpt = outcomeExcerpt(input.prompt) ?? "";
    noteInputs.push(input.prompt);
    const script = noteScripts.get(excerpt)?.shift() ?? { text: null };
    yield* Deferred.succeed(noteRequest(excerpt), undefined);
    return yield* runNoteScript(script);
  });

  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(provider.adapter),
    { sideChatTextGeneration },
  );

  const mark = EventSink.EventSinkV2.use((eventSink) => eventSink.latestSequence());

  /** The first value `pick` finds in the events after `after`, replayed and then live. */
  const awaitPicked = <A>(
    after: number,
    pick: (event: OrchestrationV2DomainEvent) => A | undefined,
  ) =>
    EventSink.EventSinkV2.use((eventSink) =>
      eventSink.stream({ afterSequence: after }).pipe(
        Stream.map((stored) => pick(stored.event)),
        Stream.filter((value): value is A => value !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      ),
    );

  const awaitEvent = (after: number, predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
    awaitPicked(after, (event) => (predicate(event) ? event : undefined));

  const awaitRun = (after: number, messageId: MessageId, status: OrchestrationV2Run["status"]) =>
    awaitPicked(after, (event) =>
      event.type === "run.updated" &&
      event.payload.userMessageId === messageId &&
      event.payload.status === status
        ? event.payload
        : undefined,
    );

  const awaitOutcome = (
    after: number,
    threadId: ThreadId,
    status: OrchestrationV2SideChatOutcome["status"],
  ) =>
    awaitPicked(after, (event) =>
      event.type === "thread.metadata-updated" &&
      event.threadId === threadId &&
      event.payload.sideChat?.done?.outcome.status === status
        ? event.payload
        : undefined,
    );

  let sendCount = 0;
  const send = Effect.fn("SideChatHarness.send")(function* (
    threadId: ThreadId,
    text: string,
    options: Partial<Pick<MessageDispatch, "dispatchMode" | "scheduledTaskId">> & {
      /** Defaults to `completed`, or `running` when the text holds its turn with `[hold]`. */
      readonly await?: "completed" | "running" | "none";
    } = {},
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    sendCount += 1;
    const messageId = MessageId.make(`message:send:${sendCount}`);
    const after = yield* mark;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${sendCount}`),
      threadId,
      messageId,
      text,
      attachments: [],
      dispatchMode: options.dispatchMode ?? { type: "start_immediately" },
      ...(options.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: options.scheduledTaskId }),
      createdBy: "user",
      creationSource: "web",
    });
    const awaited = options.await ?? (text.includes("[hold]") ? "running" : "completed");
    if (awaited !== "none") yield* awaitRun(after, messageId, awaited);
    return messageId;
  });

  const createLesson = Effect.fn("SideChatHarness.createLesson")(function* (text: string) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`lesson:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Lesson",
      modelSelection: LESSON_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, text);
    return threadId;
  });

  /** Opens a side chat on `label` as highlighted in the parent's latest assistant reply. */
  const openSideChat = Effect.fn("SideChatHarness.openSideChat")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly label: string;
  }) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages } = yield* orchestrator.getThreadProjection(input.parentThreadId);
    const reply = messages.findLast((message) => message.role === "assistant");
    const start = reply?.text.indexOf(input.label) ?? -1;
    if (reply === undefined || start === -1) {
      return yield* Effect.die(
        new Error(`No reply in ${input.parentThreadId} contains "${input.label}".`),
      );
    }
    const end = start + input.label.length;
    const threadId = ThreadId.make(`side:${input.label.replaceAll(" ", "-")}`);
    yield* orchestrator.dispatch({
      type: "thread.side_chat.open",
      commandId: CommandId.make(`open:${input.label}`),
      threadId,
      anchorThreadId: input.parentThreadId,
      anchor: {
        threadId: input.parentThreadId,
        messageId: reply.id,
        start,
        end,
        prefix: reply.text.slice(Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH), start),
        suffix: reply.text.slice(end, end + ASSISTANT_CITATION_CONTEXT_LENGTH),
      },
      excerpt: input.label,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

  let finishCount = 0;
  const finish = Effect.fn("SideChatHarness.finish")(function* (
    threadId: ThreadId,
    options: { readonly discard?: boolean } = {},
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    finishCount += 1;
    return yield* orchestrator.dispatch({
      type: "thread.side_chat.done",
      commandId: CommandId.make(`done:${threadId}:${finishCount}`),
      threadId,
      ...(options.discard === undefined ? {} : { discard: options.discard }),
      createdBy: "user",
      creationSource: "web",
    });
  });

  const thread = (threadId: ThreadId) =>
    Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    ).pipe(Effect.map((projection) => projection.thread));

  return {
    layer,
    prompts: (threadId: ThreadId): ReadonlyArray<string> =>
      provider.prompts.filter((prompt) => prompt.threadId === threadId).map(({ text }) => text),
    outcomeInputs: (): ReadonlyArray<string> => [...noteInputs],
    outcomeInputFor: (excerpt: string): string | undefined =>
      noteInputs.findLast((prompt) => outcomeExcerpt(prompt) === excerpt),
    /** Queues the answers of the next notes written for `excerpt`; after them, no note. */
    scriptNote: (excerpt: string, ...results: ReadonlyArray<SideChatNoteScript>): void => {
      noteScripts.set(excerpt, [...(noteScripts.get(excerpt) ?? []), ...results]);
    },
    /** Queues opening-summary answers selected by a marker in the conversation input. */
    scriptOpening: (marker: string, ...results: ReadonlyArray<SideChatNoteScript>): void => {
      openingScripts.set(marker, [...(openingScripts.get(marker) ?? []), ...results]);
    },
    /** Resolves once the note writer has asked for a note on `excerpt`. */
    noteRequested: (excerpt: string) => Deferred.await(noteRequest(excerpt)),
    finishHeldTurn: provider.finishHeldTurn,
    mark,
    awaitEvent,
    awaitRun,
    awaitOutcome,
    createLesson,
    send,
    openSideChat,
    finish,
    thread,
  };
});

export type SideChatHarness = Effect.Success<ReturnType<typeof makeSideChatHarness>>;
