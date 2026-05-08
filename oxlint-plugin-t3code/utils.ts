import type { ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSAsExpression
  | ESTree.TSTypeAssertion;

type AstNode = ESTree.Node;

const asAstNode = (node: unknown): Option.Option<AstNode> =>
  typeof node === "object" && node !== null && "type" in node && typeof node.type === "string"
    ? Option.some(node as AstNode)
    : Option.none();

const isExpressionWrapper = (node: AstNode): node is ExpressionWrapper =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSTypeAssertion";

export function unwrapExpression(node: unknown): Option.Option<AstNode> {
  let current = asAstNode(node);

  while (Option.isSome(current) && isExpressionWrapper(current.value)) {
    current = asAstNode(current.value.expression);
  }

  return current;
}

export function getPropertyName(node: unknown): Option.Option<string> {
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

export function isIdentifier(node: Option.Option<AstNode>, name?: string): boolean {
  if (Option.isNone(node)) return false;
  const expression = node.value;
  return (
    expression.type === "Identifier" &&
    typeof expression.name === "string" &&
    (name === undefined || expression.name === name)
  );
}
