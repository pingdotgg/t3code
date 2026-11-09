import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "kiro"
          ? "Kiro"
          : runtime.driver === "acpRegistry"
            ? "acpRegistry"
            : runtime.driver === "fx"
              ? "fx"
              : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });
  // Grok's flavor sets `supportsCompaction`; Kiro compacts through its own request instead.
  const compactsThroughPrompt = runtime.driver === "grok";
  // The ACP adapter resends these instructions until a prompt that carried them succeeds.
  // Cancelled, refused, and failed prompts do not establish delivery.
  // Compactions the adapter observes, and closed sessions, reset that.
  const instructedSessionIds = new Set<unknown>();
  let pendingPrompt:
    | { readonly sessionId: unknown; readonly instructed: boolean; readonly compact: boolean }
    | undefined;
  let pendingKiroCompact: { readonly sessionId: unknown } | undefined;

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type === "emit_inbound") {
        const frame = asFrame(entry.frame);
        if (frame?.kind === "response" && frame.method === "session/prompt" && pendingPrompt) {
          const stopReason = isRecord(frame.result) ? frame.result.stopReason : undefined;
          const delivered =
            frame.error === undefined &&
            stopReason !== "cancelled" &&
            stopReason !== "refusal" &&
            stopReason !== "error";
          if (delivered && pendingPrompt.compact) {
            instructedSessionIds.delete(pendingPrompt.sessionId);
          } else if (delivered && pendingPrompt.instructed) {
            instructedSessionIds.add(pendingPrompt.sessionId);
          }
          pendingPrompt = undefined;
        }
        if (
          frame?.kind === "response" &&
          frame.method === "_kiro/session/compact" &&
          pendingKiroCompact
        ) {
          const refused = isRecord(frame.result) && frame.result.success === false;
          if (frame.error === undefined && !refused)
            instructedSessionIds.delete(pendingKiroCompact.sessionId);
          pendingKiroCompact = undefined;
        }
        const update =
          frame?.method === "session/update" && isRecord(frame.params)
            ? frame.params.update
            : undefined;
        if (
          isRecord(update) &&
          update.sessionUpdate === "compaction_update" &&
          update.status === "completed" &&
          isRecord(frame?.params)
        ) {
          instructedSessionIds.delete(frame.params.sessionId);
        }
        return entry;
      }
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        return frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if ("method" in frame && frame.method === "session/close") {
        // A closed session comes back in a new runtime, which resends the instructions.
        instructedSessionIds.clear();
        pendingPrompt = undefined;
        return entry;
      }
      if (
        "method" in frame &&
        frame.method === "_kiro/session/compact" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "sessionId" in frame.params
      ) {
        // Once it succeeds, Kiro's native compaction makes the next prompt resend them.
        pendingKiroCompact = { sessionId: frame.params.sessionId };
        return entry;
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const promptSessionId = "sessionId" in frame.params ? frame.params.sessionId : undefined;
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const firstText = promptPartText(prompt[0])?.trim();
        // Like the adapter, native slash commands go out without instructions. Where the agent
        // compacts through the prompt, a successful `/compact` makes the next prompt resend them.
        if (firstText?.startsWith("/") === true) {
          pendingPrompt = {
            sessionId: promptSessionId,
            instructed: false,
            compact:
              compactsThroughPrompt && prompt.length === 1 && /^\/compact(?:\s|$)/.test(firstText),
          };
          return entry;
        }
        if (instructedSessionIds.has(promptSessionId)) {
          pendingPrompt = undefined;
          return entry;
        }
        pendingPrompt = { sessionId: promptSessionId, instructed: true, compact: false };
        const lastText = promptPartText(prompt.at(-1));
        // A recording that switched models mid-thread already carries the
        // instructions for the model each prompt ran on.
        if (lastText === instructions || lastText?.startsWith("<runtime_info>") === true) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}

function promptPartText(part: unknown): string | undefined {
  return typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
    ? part.text
    : undefined;
}

type ReplayFrame = {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFrame(value: unknown): ReplayFrame | undefined {
  return isRecord(value) ? value : undefined;
}
