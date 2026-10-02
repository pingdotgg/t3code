import type { OrchestratorFixtureInput } from "../shared.ts";

export const PI_COMPACTION_MARKER = "compaction-marker-4Z7Q";
const PI_COMPACTION_INSTRUCTED = `/compact keep the opaque marker ${PI_COMPACTION_MARKER}`;
const PI_COMPACTION_RECALL_PROMPT =
  "Return the opaque marker I asked you to remember. Respond with only the marker.";

/**
 * Two compactions against a real Pi. The first, with custom instructions,
 * comes after a single exchange, which Pi refuses as too small to compact. The
 * second is a bare `/compact`, routed through the adapter's compactThread,
 * after enough turns that Pi really summarizes. The recording workspace sets a
 * tiny `keepRecentTokens` so a short conversation is compactable, and the last
 * turn proves the summary kept the marker.
 */
export function piCompactionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      {
        type: "message",
        text: `Remember the opaque marker ${PI_COMPACTION_MARKER} for later. Respond with exactly: compaction marker stored`,
      },
      { type: "message", text: PI_COMPACTION_INSTRUCTED },
      { type: "message", text: "Respond with exactly: second compaction fixture turn" },
      { type: "message", text: "Respond with exactly: third compaction fixture turn" },
      { type: "message", text: "/compact" },
      { type: "message", text: PI_COMPACTION_RECALL_PROMPT },
    ],
  };
}
