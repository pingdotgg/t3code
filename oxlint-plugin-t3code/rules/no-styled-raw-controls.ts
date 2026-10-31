import { defineRule, type ESTree } from "@oxlint/plugins";

// Interactive intrinsic elements. A styled one is a hand-built Button, Input,
// Select or link: it skips the components/ui variants, so it drifts from every
// other control and escapes shadcn/no-restyle, which only checks ui components.
const RAW_CONTROLS = new Set(["a", "button", "input", "select", "summary", "textarea"]);

// Appearance belongs to UI primitives; layout, overflow and resets stay on raw controls.
const APPEARANCE = [
  /^text-(?!(?:left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$)/u,
  /^(?:font|tracking|leading|decoration|underline-offset)-/u,
  /^(?:underline|italic|uppercase|lowercase|capitalize)$/u,
  /^p[xytrblse]?-/u,
  /^(?:gap|space-[xy])-/u,
  // rounded-[inherit] follows the parent's shape rather than choosing one.
  /^rounded(?:-(?!\[inherit\]$)|$)/u,
  /^border(?:-|$)/u,
  /^ring(?:-|$)/u,
  /^outline-(?!(?:none|hidden)$)/u,
  /^(?:bg|from|via|to|fill|stroke|caret|accent|placeholder)-/u,
  // opacity-0 hides a native control under a styled one (a file or range input),
  // so it is a hit target, not a look.
  /^(?:shadow|inset-shadow|drop-shadow|backdrop|blur)(?:-|$)/u,
  /^opacity-(?!0$)/u,
  /^(?:surface|kbd)-/u,
];

/** The class without variants (`hover:`, `sm:`, `[&_svg]:`), important marks or a negative sign. */
function baseClass(token: string): string {
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

export function appearanceClasses(value: string): ReadonlyArray<string> {
  return value
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .filter((token) => APPEARANCE.some((pattern) => pattern.test(baseClass(token))));
}

type ResolveConstant = (
  identifier: ESTree.IdentifierReference,
) => ESTree.VariableDeclarator | undefined;

/**
 * Every static string a className expression can produce: literals, cn() arguments, ternary arms,
 * and same-file constants they name.
 */
function classStrings(
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

const readMaxOccurrences = (options: ReadonlyArray<unknown>): number => {
  const [first] = options;
  return typeof first === "object" &&
    first !== null &&
    "maxOccurrences" in first &&
    typeof first.maxOccurrences === "number"
    ? first.maxOccurrences
    : 0;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow appearance classes on raw interactive elements; render the components/ui control instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxOccurrences: {
            type: "integer",
            minimum: 0,
            description:
              "Legacy debt ceiling for this file: styled raw controls beyond this count are reported.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    const allowedCount = readMaxOccurrences(context.options);
    const resolveConstant: ResolveConstant = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          const definition = variable.defs.find((def) => def.type === "Variable");
          return definition?.parent?.type === "VariableDeclaration" &&
            definition.parent.kind === "const" &&
            definition.node.type === "VariableDeclarator" &&
            definition.node.id.type === "Identifier"
            ? definition.node
            : undefined;
        }
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    };
    // Checked once the whole file is read, so a constant declared below its use still counts.
    const classNames: Array<{
      element: string;
      value: unknown;
      report: (message: string) => void;
    }> = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !RAW_CONTROLS.has(node.name.name)) return;
        const element = node.name.name;

        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier")
            continue;
          if (attribute.name.name !== "className" || attribute.value === null) continue;
          classNames.push({
            element,
            value: attribute.value,
            report: (message) => context.report({ node: attribute, message }),
          });
        }
      },
      "Program:exit"() {
        let occurrenceCount = 0;
        for (const { element, value, report } of classNames) {
          const found = classStrings(value, resolveConstant).flatMap(appearanceClasses);
          if (found.length === 0) continue;

          occurrenceCount++;
          if (occurrenceCount <= allowedCount) continue;

          const replacement =
            element === "a"
              ? "Button render={<a />} or InlineButton"
              : element === "input" || element === "textarea" || element === "select"
                ? "Input, Textarea or Select"
                : "Button with a variant and size";
          report(
            `<${element}> is styled by hand (${found.slice(0, 4).join(" ")}). Render ${replacement} from components/ui; only layout classes belong on a raw control.`,
          );
        }
      },
    };
  },
});
