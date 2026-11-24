import type { ESTree } from "@oxlint/plugins";

/** The class without variants (`hover:`, `sm:`, `[&_svg]:`), important marks or a negative sign. */
export function baseClass(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/gu, "").replace(/^-/u, "");
}

export const classTokens = (value: string): ReadonlyArray<string> =>
  value.split(/\s+/u).filter((token) => token.length > 0);

export type ResolveConstant = (
  identifier: ESTree.IdentifierReference,
) => ESTree.VariableDeclarator | undefined;

/**
 * Every static string a className expression can produce: literals, cn() arguments, ternary arms,
 * and same-file constants they name.
 */
export function classStrings(
  node: unknown,
  resolveConstant: ResolveConstant,
  out: Array<string> = [],
  seen: Set<ESTree.VariableDeclarator> = new Set(),
): Array<string> {
  if (typeof node !== "object" || node === null || !("type" in node)) return out;
  const expression = node as { type: string } & Record<string, unknown>;
  const recurse = (inner: unknown) => classStrings(inner, resolveConstant, out, seen);
  switch (expression.type) {
    case "Identifier": {
      const declaration = resolveConstant(node as ESTree.IdentifierReference);
      if (declaration === undefined || seen.has(declaration)) break;
      seen.add(declaration);
      recurse(declaration.init);
      break;
    }
    case "Literal":
      if (typeof expression.value === "string") out.push(expression.value);
      break;
    case "TemplateLiteral":
      for (const quasi of expression.quasis as Array<{ value: { cooked?: string } }>) {
        out.push(quasi.value.cooked ?? "");
      }
      for (const inner of expression.expressions as Array<unknown>) recurse(inner);
      break;
    case "JSXExpressionContainer":
      recurse(expression.expression);
      break;
    case "ConditionalExpression":
      recurse(expression.consequent);
      recurse(expression.alternate);
      break;
    case "LogicalExpression":
      if (expression.operator === "||" || expression.operator === "??") {
        recurse(expression.left);
      }
      recurse(expression.right);
      break;
    case "BinaryExpression":
      if (expression.operator === "+") {
        recurse(expression.left);
        recurse(expression.right);
      }
      break;
    case "CallExpression":
      for (const argument of expression.arguments as Array<unknown>) recurse(argument);
      break;
    case "ArrayExpression":
      for (const element of expression.elements as Array<unknown>) recurse(element);
      break;
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      recurse(expression.expression);
      break;
  }
  return out;
}

export const CEILINGS_COMMAND = "vp run lint:ceilings";

export const maxOccurrencesSchema = [
  {
    type: "object" as const,
    properties: {
      maxOccurrences: {
        type: "integer" as const,
        minimum: 0,
        description:
          "Legacy debt ceiling for this file, generated into lint-ceilings.json. The file's count must equal it.",
      },
    },
    additionalProperties: false,
  },
];

export const readMaxOccurrences = (options: ReadonlyArray<unknown>): number => {
  const [first] = options;
  return typeof first === "object" &&
    first !== null &&
    "maxOccurrences" in first &&
    typeof first.maxOccurrences === "number"
    ? first.maxOccurrences
    : 0;
};

/**
 * Ceilings are exact, so headroom can't hide new occurrences. Reported at the top of the file, as
 * a whole-file span would print the file. scripts/lint-ceilings.ts reads "file has N".
 */
export function ceilingMismatch(ceiling: number, count: number) {
  const at = (message: string) => ({ loc: { line: 1, column: 0 }, message });
  if (count === ceiling) return undefined;
  if (count < ceiling) {
    return at(
      `Debt ceiling ${ceiling}, file has ${count}: lower it to ${count} with \`${CEILINGS_COMMAND}\`.`,
    );
  }
  return at(
    `Debt ceiling ${ceiling}, file has ${count}: fix the ${count - ceiling} new occurrences reported in this file. Ceilings never go up, and a new file starts at 0.`,
  );
}

interface CommentSource {
  getAllComments(): ReadonlyArray<{
    value: string;
    loc: { start: { line: number }; end: { line: number } };
  }>;
}

/**
 * Lines where a disable comment names this rule. Occurrences there are still reported, so the
 * comment stays in use, but they don't count toward the file's ceiling.
 */
export function suppressedLines(source: CommentSource, rule: string): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const comment of source.getAllComments()) {
    const match = /^\s*(?:oxlint|eslint)-disable-(next-line|line)\b(.*?)(?:\s--|$)/su.exec(
      comment.value,
    );
    if (!match) continue;
    const rules = (match[2] ?? "").split(",").map((name) => name.trim());
    if (rules.some(Boolean) && !rules.includes(rule)) continue;
    lines.add(match[1] === "line" ? comment.loc.start.line : comment.loc.end.line + 1);
  }
  return lines;
}
