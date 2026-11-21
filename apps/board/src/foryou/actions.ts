import { respondToThreadApproval } from "@t3tools/client-runtime/operations";
import {
  secretRequestAnswerInput,
  secretRequestFailureMessage,
  type SecretRequestItem,
  type SecretRequestReply,
} from "@t3tools/client-runtime/secret-request";
import {
  createEnvironmentCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import {
  type ChatAttachment,
  type EnvironmentId,
  MessageId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  type EngineRequest,
  type ForYouAnswer,
  type ForYouCard,
  forYouMessage,
} from "../domain/forYou";
import { trackerCall } from "../issues/issueLinks";
import { failureText } from "../settings/failureText";
import { newId } from "../state/boards";
import { forYouSentAtom } from "../state/forYou";
import { runTrackerCall } from "../state/issues";
import { serverEnvironment } from "../state/server";
import { environmentThreads, startTurn } from "../state/threads";

const respondApproval = createEnvironmentCommand(connectionAtomRuntime, {
  label: "board:foryou:respond-approval",
  execute: respondToThreadApproval,
});

export interface ForYouTarget {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  readonly boardId: string;
  /** The project the board is in, which tracker writes are made through. */
  readonly projectId: string;
}

type FileCard = Extract<ForYouCard, { readonly origin: "file" }>;
type EngineCard = Extract<ForYouCard, { readonly origin: "engine" }>;

const CHOICE_LABEL = {
  approve: "Approved",
  hold: "Held",
  resume: "Resumed",
  read: "Marked read",
} as const;

const answerLabel = (answer: ForYouAnswer) =>
  answer.type === "choice" ? CHOICE_LABEL[answer.choice] : `Answered: ${answer.text}`;

const setSent = (target: ForYouTarget, card: ForYouCard, choice: string, remove: boolean) => {
  const all = target.registry.get(forYouSentAtom);
  const board = new Map(all[target.boardId]);
  if (remove) board.delete(card.id);
  else {
    board.set(card.id, {
      card,
      choice,
      status: card.origin === "file" ? card.item.status : "open",
    });
  }
  target.registry.set(forYouSentAtom, { ...all, [target.boardId]: board });
};

/**
 * Sends `text` to an orchestrator as the user, with the orchestrator's own runtime mode. Resolves
 * to the failure text, or null once sent. `beforeSend` runs once the thread has loaded, so a
 * caller that marks a card as sent does not mark one that cannot be.
 */
export async function messageOrchestrator(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  orchestratorThreadId: string | null,
  text: () => Promise<string>,
  beforeSend: () => void = () => undefined,
  attachments: ReadonlyArray<ChatAttachment> = [],
): Promise<string | null> {
  if (orchestratorThreadId === null) return "Start this board's orchestrator before answering.";
  const threadId = ThreadId.make(orchestratorThreadId);
  const { data } = AsyncResult.getOrElse(
    registry.get(environmentThreads.stateAtom(environmentId, threadId)),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  );
  const projection = Option.getOrNull(data);
  if (projection === null) return "The orchestrator has not loaded yet. Try again in a moment.";
  beforeSend();
  const result = await runAtomCommand(
    registry,
    startTurn,
    {
      environmentId,
      input: {
        threadId,
        message: {
          messageId: MessageId.make(newId()),
          role: "user",
          text: await text(),
          attachments,
        },
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
      },
    },
    { reportFailure: false },
  );
  return result._tag === "Success" ? null : failureText(result);
}

/**
 * Answers a `foryou.jsonl` item by messaging its orchestrator, which records the answer in the file.
 * The card reads as sent from the click, and goes back if the message does not go. Approving a
 * `tracker_write` item makes its change first, and the message carries the outcome. A change that
 * fails leaves the card to retry. Hold changes nothing. Resolves to the failure text, or null once sent.
 */
export async function answerItem(
  target: ForYouTarget,
  orchestratorThreadId: string | null,
  card: FileCard,
  answer: ForYouAnswer,
): Promise<string | null> {
  performance.mark("board:foryou-click", { detail: { id: card.id } });
  const { item } = card;
  let result: string | undefined;
  let failure: string | null;
  try {
    failure = await messageOrchestrator(
      target.registry,
      target.environmentId,
      orchestratorThreadId,
      async () => {
        if (
          item.kind === "tracker_write" &&
          answer.type === "choice" &&
          answer.choice === "approve"
        ) {
          result ??= await runTrackerCall(
            target.registry,
            target.environmentId,
            trackerCall(item.write, target.projectId),
          );
          return forYouMessage(card.id, { ...answer, result });
        }
        return forYouMessage(card.id, answer);
      },
      () => setSent(target, card, answerLabel(answer), false),
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure === null) return null;
  if (result === undefined) {
    setSent(target, card, "", true);
    return failure;
  }
  return `${failure} The tracker change was already made: ${result}`;
}

/** Answers an engine approval directly. The card leaves once the engine drops the request. */
export async function answerApproval(
  target: ForYouTarget,
  card: EngineCard,
  request: EngineRequest,
  decision: "accept" | "decline",
): Promise<string | null> {
  performance.mark("board:foryou-click", { detail: { id: card.id } });
  setSent(target, card, decision === "accept" ? "Approved" : "Declined", false);
  const result = await runAtomCommand(
    target.registry,
    respondApproval,
    {
      environmentId: target.environmentId,
      input: {
        threadId: ThreadId.make(request.threadId),
        requestId: RuntimeRequestId.make(request.id),
        decision,
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return null;
  setSent(target, card, "", true);
  return failureText(result);
}

/** Answers a secret request directly, with the value never leaving the card's own state. */
export async function answerSecret(
  target: ForYouTarget,
  card: EngineCard,
  item: SecretRequestItem,
  reply: SecretRequestReply,
): Promise<string | null> {
  const input = secretRequestAnswerInput(item, reply);
  if (input === null) return "Enter the secret first.";
  performance.mark("board:foryou-click", { detail: { id: card.id } });
  setSent(target, card, reply.type === "decline" ? "Declined" : "Saved securely", false);
  const result = await runAtomCommand(
    target.registry,
    serverEnvironment.answerSecretRequest,
    { environmentId: target.environmentId, input },
    // The failure cause holds the secret, so it stays out of the console.
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Success") return null;
  setSent(target, card, "", true);
  return isAtomCommandInterrupted(result)
    ? null
    : secretRequestFailureMessage(squashAtomCommandFailure(result));
}
