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
import { type EnvironmentId, MessageId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  type EngineRequest,
  type ForYouAnswer,
  type ForYouCard,
  forYouMessage,
} from "../domain/forYou";
import { failureText } from "../settings/failureText";
import { newId } from "../state/boards";
import { forYouSentAtom } from "../state/forYou";
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
 * Answers a `foryou.jsonl` item by messaging its orchestrator, which records the answer in the file.
 * The card reads as sent from the click, and goes back if the message does not go. Resolves to the
 * failure text, or null once sent.
 */
export async function answerItem(
  target: ForYouTarget,
  orchestratorThreadId: string | null,
  card: FileCard,
  answer: ForYouAnswer,
): Promise<string | null> {
  if (orchestratorThreadId === null) return "Start this board's orchestrator before answering.";
  performance.mark("board:foryou-click", { detail: { id: card.id } });
  const threadId = ThreadId.make(orchestratorThreadId);
  const { data } = AsyncResult.getOrElse(
    target.registry.get(environmentThreads.stateAtom(target.environmentId, threadId)),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  );
  const projection = Option.getOrNull(data);
  if (projection === null) return "The orchestrator has not loaded yet. Try again in a moment.";
  setSent(target, card, answerLabel(answer), false);
  const result = await runAtomCommand(
    target.registry,
    startTurn,
    {
      environmentId: target.environmentId,
      input: {
        threadId,
        message: {
          messageId: MessageId.make(newId()),
          role: "user",
          text: forYouMessage(card.id, answer),
          attachments: [],
        },
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return null;
  setSent(target, card, "", true);
  return failureText(result);
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
