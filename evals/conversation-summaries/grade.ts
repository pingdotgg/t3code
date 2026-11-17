import type { CondensedCase, LeafCase } from "./cases.ts";

const MAX_CHARS = 1_200;

type Statement = { readonly text: string; readonly citations: ReadonlyArray<string> };
type Rules = Pick<LeafCase, "mustMention" | "attributed" | "mustNot" | "supportedBy">;

function gradeStatements(
  refs: ReadonlySet<string>,
  statements: ReadonlyArray<Statement>,
  rules: Rules,
  maxChars: number | undefined,
): ReadonlyArray<string> {
  const texts = statements.map((statement) => statement.text);
  const failures: Array<string> = [];
  if (statements.length === 0) failures.push("no statements");
  for (const statement of statements) {
    if (!statement.citations.some((ref) => refs.has(ref.trim())))
      failures.push(`cites no given source: ${statement.text}`);
    for (const ref of statement.citations)
      if (!refs.has(ref.trim())) failures.push(`unknown citation ${ref}: ${statement.text}`);
    for (const rule of rules.supportedBy ?? [])
      if (
        new RegExp(rule.when, "i").test(statement.text) &&
        !rule.refs.some((ref) => statement.citations.includes(ref))
      )
        failures.push(`missing supporting source ${rule.refs.join(" or ")}: ${statement.text}`);
  }
  if (maxChars !== undefined) {
    const chars = texts.reduce((sum, text) => sum + text.trim().length, 0);
    if (chars > maxChars) failures.push(`${chars} characters, over ${maxChars}`);
  }
  for (const pattern of rules.mustMention)
    if (!texts.some((text) => new RegExp(pattern).test(text))) failures.push(`missing ${pattern}`);
  for (const rule of rules.attributed)
    for (const text of texts)
      if (new RegExp(rule.when).test(text) && !new RegExp(rule.require, "i").test(text))
        failures.push(`${rule.when} without ${rule.require}: ${text}`);
  for (const pattern of rules.mustNot)
    for (const text of texts)
      if (new RegExp(pattern, "i").test(text)) failures.push(`${pattern}: ${text}`);
  return failures;
}

/** Every way a roll-up reply breaks the case's rules; empty when it passes. */
export function gradeCondensed(
  fixture: CondensedCase,
  statements: ReadonlyArray<Statement>,
): ReadonlyArray<string> {
  return gradeStatements(
    new Set(fixture.summaries.map((_, index) => `M${index + 1}`)),
    statements,
    fixture,
    MAX_CHARS,
  );
}

/** Every way a leaf reply breaks the case's rules; empty when it passes. */
export function gradeLeaf(
  fixture: LeafCase,
  statements: ReadonlyArray<Statement>,
): ReadonlyArray<string> {
  return gradeStatements(
    new Set(fixture.messages.map((_, index) => `M${index + 1}`)),
    statements,
    fixture,
    undefined,
  );
}
