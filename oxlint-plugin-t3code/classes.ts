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

export const maxOccurrencesSchema = [
  {
    type: "object" as const,
    properties: {
      maxOccurrences: {
        type: "integer" as const,
        minimum: 0,
        description:
          "Legacy debt ceiling for this file: occurrences beyond this count are reported.",
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
