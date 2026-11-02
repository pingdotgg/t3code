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
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : runtime.driver === "fx"
            ? "fx"
            : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });
  // The ACP adapter resends these instructions until a prompt that carried them succeeds.
  // Cancelled, refused, and failed prompts do not establish delivery.
  const instructedSessionIds = new Set<unknown>();
  let pendingInstructedPrompt: { readonly sessionId: unknown } | undefined;

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type === "emit_inbound") {
        const frame = entry.frame;
        if (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "response" &&
          "method" in frame &&
          frame.method === "session/prompt" &&
          "result" in frame &&
          pendingInstructedPrompt !== undefined
        ) {
          const result = frame.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("stopReason" in result) ||
            (result.stopReason !== "cancelled" &&
              result.stopReason !== "refusal" &&
              result.stopReason !== "error")
          ) {
            instructedSessionIds.add(pendingInstructedPrompt.sessionId);
          }
          pendingInstructedPrompt = undefined;
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
        pendingInstructedPrompt = undefined;
        if (instructedSessionIds.has(promptSessionId)) return entry;
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        // Like the adapter, native slash commands go out without instructions.
        if (promptPartText(prompt[0])?.trimStart().startsWith("/") === true) return entry;
        pendingInstructedPrompt = { sessionId: promptSessionId };
        if (promptPartText(prompt.at(-1))?.startsWith("<runtime_info>") === true) return entry;
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
