import * as Option from "effect/Option";

const asAstNode = (node) =>
  typeof node === "object" && node !== null && "type" in node && typeof node.type === "string"
    ? Option.some(node)
    : Option.none();

const isExpressionWrapper = (node) =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSTypeAssertion";

export function unwrapExpression(node) {
  let current = asAstNode(node);

  while (Option.isSome(current) && isExpressionWrapper(current.value)) {
    current = asAstNode(current.value.expression);
  }

  return current;
}

export function getPropertyName(node) {
  return Option.flatMap(asAstNode(node), (expression) => {
    if (expression.type === "Identifier" && typeof expression.name === "string") {
      return Option.some(expression.name);
    }
    if (expression.type === "PrivateIdentifier" && typeof expression.name === "string") {
      return Option.some(expression.name);
    }
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return Option.some(expression.value);
    }
    return Option.none();
  });
}

export function isIdentifier(node, name) {
  if (Option.isNone(node)) return false;
  const expression = node.value;
  return (
    expression.type === "Identifier" &&
    typeof expression.name === "string" &&
    (name === undefined || expression.name === name)
  );
}
