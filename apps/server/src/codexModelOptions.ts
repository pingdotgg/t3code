import type { ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}

export const CODEX_AUTOMATIC_CYBER_ACCESS_PROGRAM_ID = "automatic";

/** Undefined leaves Codex's automatic cyber treatment in place. */
export function getCodexCyberAccessProgramOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const value = getModelSelectionStringOptionValue(modelSelection, "cyberAccessProgram");
  return value === CODEX_AUTOMATIC_CYBER_ACCESS_PROGRAM_ID ? undefined : value;
}
