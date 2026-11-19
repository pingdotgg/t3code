import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { SearchMatchHintField } from "./paletteSearch.ts";

const MATCH_HINT_LABELS: Readonly<Record<SearchMatchHintField, string>> = {
  "pull-request": msg("PR", { $context: "abbreviation of pull request" }),
  branch: msg("Branch"),
  project: msg("Project"),
  environment: msg("Environment"),
  reference: msg("ID or link"),
};

/** @public */
export function searchMatchHintLabel(
  field: SearchMatchHintField,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(MATCH_HINT_LABELS[field]);
}
