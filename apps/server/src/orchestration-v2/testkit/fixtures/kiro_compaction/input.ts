import type { OrchestratorFixtureInput } from "../shared.ts";

export const KIRO_COMPACTION_MARKER = "compaction-marker-7K2V";

export function kiroCompactionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      {
        type: "message",
        text: `Remember the opaque marker ${KIRO_COMPACTION_MARKER} for later. Respond with exactly: compaction marker stored`,
      },
      { type: "message", text: "/compact" },
      {
        type: "message",
        text: "Return the opaque marker I asked you to remember. Respond with only the marker.",
      },
    ],
  };
}
