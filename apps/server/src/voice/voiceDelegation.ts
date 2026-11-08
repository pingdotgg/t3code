// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { CommandId, MessageId, VoiceApiError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveAppDisplayName } from "../appDisplayName.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";

/** Only the thread-management entry points a spoken request needs. */
export type VoiceDelegationThreads = Pick<
  ThreadManagementServiceShape,
  "getThreadShell" | "sendToThread" | "waitForThread" | "getThreadRecords"
>;

/** Matches the realtime voice call's own budget for one delegated request. */
const VOICE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

const unavailable = (message: string) =>
  new VoiceApiError({ reason: "upstream_unavailable", message });

const describe = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The selected agent could not be reached.";
};

/**
 * Run one spoken request as a normal turn in `threadId` and resolve with the
 * text the selected agent produced, so voice never becomes a second way to
 * reach a provider.
 */
export const delegateVoiceRequest = Effect.fn("delegateVoiceRequest")(function* (
  threads: VoiceDelegationThreads,
  threadId: ThreadId,
  prompt: string,
) {
  const shell = yield* threads
    .getThreadShell(threadId)
    .pipe(Effect.mapError((error) => unavailable(describe(error))));
  if (shell === null || shell.archivedAt !== null) {
    return yield* unavailable(
      `Open an existing, active ${resolveAppDisplayName()} task before starting voice.`,
    );
  }
  if (shell.activeRunId !== null) {
    return yield* unavailable(
      "The selected agent is already working. Wait for its answer before sending another voice request.",
    );
  }
  // No model selection: the task's own selection decides who answers — never the voice layer.
  const sent = yield* threads
    .sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(`voice:${randomUUID()}`),
      threadId,
      messageId: MessageId.make(randomUUID()),
      text: prompt,
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    })
    .pipe(Effect.mapError((error) => unavailable(describe(error))));
  const waited = yield* threads
    .waitForThread({
      projectId: shell.projectId,
      threadId,
      runId: sent.run.id,
      timeoutMs: VOICE_REQUEST_TIMEOUT_MS,
    })
    .pipe(Effect.mapError((error) => unavailable(describe(error))));
  if (waited.timedOut || waited.run === null) {
    return yield* unavailable(
      "The selected agent is still working. Check the task for its answer.",
    );
  }
  if (waited.run.status !== "completed") {
    const latest = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    return yield* unavailable(
      latest?.lastError ?? "The selected agent's turn stopped before completing.",
    );
  }
  // Only this run's messages: a provider can still be flushing the previous
  // turn's messages when this one starts, and voice must never read those out.
  const records = yield* threads
    .getThreadRecords(threadId, ["messages"], {
      messageRunIds: [sent.run.id],
      messageRoles: ["assistant"],
    })
    .pipe(Effect.mapError((error) => unavailable(describe(error))));
  const answer = records.messages
    .filter((message) => message.role === "assistant" && message.runId === sent.run.id)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  return answer || "The agent completed without a text response. Check the task for results.";
});
