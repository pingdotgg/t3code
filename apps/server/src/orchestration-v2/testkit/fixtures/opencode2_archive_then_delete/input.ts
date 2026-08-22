import { OPENCODE2_ARCHIVE_THEN_DELETE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2ArchiveThenDeleteInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_ARCHIVE_THEN_DELETE_PROMPT },
      { type: "archive" },
      { type: "delete" },
    ],
  };
}
