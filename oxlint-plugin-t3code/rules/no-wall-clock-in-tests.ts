import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const WALL_CLOCK_CALLS = new Set([
  "Date.now",
  "performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
]);
const VI_MOCKING_FUNCTIONS = new Set(["fn", "mock", "setSystemTime", "spyOn"]);
const MOCK_METHODS = new Set([
  "mockImplementation",
  "mockImplementationOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
]);

const MESSAGE =
  "Wall-clock reading in a test; elapsed-time assertions pass or fail with runner load. Use TestClock/`Clock` under `it.effect`, `vi.setSystemTime`, or a fixed epoch. Benchmarks live behind an env gate.";

const isStringLiteral = (node: unknown) =>
  Option.exists(
    unwrapExpression(node),
    (expression) => expression.type === "Literal" && typeof expression.value === "string",
  );

const memberPath = (node: unknown): Option.Option<ReadonlyArray<string>> => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return Option.none();
  if (expression.value.type === "Identifier") return Option.some([expression.value.name]);
  if (expression.value.type !== "MemberExpression") return Option.none();
  // `Date[now]` with a variable key is unknowable; only a literal key names a member.
  if (expression.value.computed && !isStringLiteral(expression.value.property))
    return Option.none();
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property)) return Option.none();
  return Option.map(memberPath(expression.value.object), (path) => [...path, property.value]);
};

const isWallClockCall = (callee: unknown): boolean =>
  Option.match(memberPath(callee), {
    onNone: () => false,
    onSome: (path) => WALL_CLOCK_CALLS.has(path.join(".")),
  });

const isMockingCall = (callee: unknown): boolean => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property)) return false;
  if (MOCK_METHODS.has(property.value)) return true;
  return (
    VI_MOCKING_FUNCTIONS.has(property.value) &&
    isIdentifier(unwrapExpression(expression.value.object), "vi")
  );
};

// Readings that feed a mock (or live in a vi.mock factory) seed fake time
// rather than measure the runner, so they stay allowed.
const isMockArgument = (node: ESTree.Node): boolean => {
  let child: ESTree.Node = node;
  let current = node.parent;
  while (current) {
    if (
      current.type === "CallExpression" &&
      current.callee !== child &&
      isMockingCall(current.callee)
    ) {
      return true;
    }
    child = current;
    current = current.parent;
  }
  return false;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow wall-clock readings (Date.now, new Date(), performance.now, process.hrtime) in tests.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        if (!isWallClockCall(node.callee)) return;
        if (isMockArgument(node)) return;
        context.report({ node, message: MESSAGE });
      },
      NewExpression(node) {
        if (node.arguments.length > 0) return;
        if (!isIdentifier(unwrapExpression(node.callee), "Date")) return;
        if (isMockArgument(node)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
