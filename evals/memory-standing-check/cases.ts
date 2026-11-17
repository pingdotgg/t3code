import type { FactStandingCheckStatement } from "@t3tools/provider-core/server/textGenerationPrompts";

export interface StandingCase {
  readonly id: string;
  readonly source: string;
  readonly statement: FactStandingCheckStatement;
  /** "kept" is recalled into later work; "set_aside" is stored but never recalled. */
  readonly expected: "kept" | "set_aside";
}

const audit =
  "2026-11 project-memory audit: about half of saved facts were one task's limits or code descriptions; authored Acme examples.";

export const cases: ReadonlyArray<StandingCase> = [
  {
    id: "delegate-scope-limit",
    source: audit,
    statement: {
      kind: "constraint",
      content:
        "Keep the delegated change limited to the invoice parser; do not modify the retry policy or the export queue.",
    },
    expected: "set_aside",
  },
  {
    id: "unmerged-pr-behaviour",
    source: audit,
    statement: {
      kind: "decision",
      content:
        "The open pull request that adds CSV export retries a failed upload three times before showing an error.",
    },
    expected: "set_aside",
  },
  {
    id: "one-pr-authorization",
    source: audit,
    statement: {
      kind: "convention",
      content: "For this pull request, merging without waiting for CI is authorized.",
    },
    expected: "set_aside",
  },
  {
    id: "unnamed-reference",
    source: audit,
    statement: {
      kind: "decision",
      content: "Use the new approach from the fix for every similar handler.",
    },
    expected: "set_aside",
  },
  {
    id: "live-database-privacy",
    source: audit,
    statement: {
      kind: "constraint",
      content:
        "Never open the production customer database read-write from a development machine; copy it and work on the copy.",
    },
    expected: "kept",
  },
  {
    id: "merge-order-convention",
    source: audit,
    statement: {
      kind: "convention",
      content:
        "Acme merges stacked pull requests bottom-up, and rebases each layer onto main after the layer below it merges.",
    },
    expected: "kept",
  },
];
