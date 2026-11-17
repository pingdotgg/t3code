/**
 * The forge's change request word as an ICU select key, so each sentence is written out whole
 * per word instead of taking the word as a variable. Reads the definitions' English terms.
 */
export function changeRequestTerm(terms: {
  readonly singular: string;
}): "pullRequest" | "mergeRequest" | "changeRequest" {
  if (terms.singular === "merge request") return "mergeRequest";
  return terms.singular === "change request" ? "changeRequest" : "pullRequest";
}
