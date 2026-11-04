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
            : runtime.driver === "muse"
              ? "Muse Code"
              : runtime.driver === "fx"
                ? "fx"
                : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });
  const sharedRuntimeInstructions = instructions.split("</runtime_info>\n\n")[1];

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "muse" &&
        sharedRuntimeInstructions !== undefined &&
        "method" in frame &&
        frame.method === "turn/start" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "input" in frame.params &&
        Array.isArray(frame.params.input)
      ) {
        const input: ReadonlyArray<unknown> = frame.params.input;
        const firstPart = input[0];
        if (
          typeof firstPart !== "object" ||
          firstPart === null ||
          !("type" in firstPart) ||
          firstPart.type !== "text" ||
          !("text" in firstPart) ||
          typeof firstPart.text !== "string"
        ) {
          return entry;
        }
        // Keep each turn's recorded model, effort, and user input as protocol assertions.
        const text = firstPart.text.replace(
          /^(<runtime_info>[\s\S]*?<\/runtime_info>\n\n)<pull_request_linking>[\s\S]*?<\/pull_request_linking>(?:\n\n<github_reads>[\s\S]*?<\/github_reads>)?/u,
          (_match, header: string) => `${header}${sharedRuntimeInstructions}`,
        );
        return text === firstPart.text
          ? entry
          : {
              ...entry,
              frame: {
                ...frame,
                params: {
                  ...frame.params,
                  input: [{ ...firstPart, text }, ...input.slice(1)],
                },
              },
            };
      }
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
        runtime.driver !== "muse" &&
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          typeof lastPart.text === "string" &&
          // A recording that switched models mid-thread already carries the
          // instructions for the model each prompt ran on.
          (lastPart.text === instructions || lastPart.text.startsWith("<runtime_info>"))
        ) {
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
