import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_CLOCK_DRIVERS = new Set(["adjust", "setTime"]);
const TIMER_PROMISES_MODULES = new Set(["node:timers/promises", "timers/promises"]);
const TIMER_FUNCTIONS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const SCHEDULE_WAITS = new Set(["spaced", "fixed", "exponential"]);
const TESTER_ROOTS = new Set(["it", "test"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

const REAL_CLOCK_MESSAGE =
  "Real-clock wait in a test. Await the `Deferred`/`Queue`/event that marks the milestone, or run under `it.effect` and `TestClock.adjust`. `it.live` is for subprocess/network fixtures, not for sleeping.";
const UNDRIVEN_TEST_CLOCK_MESSAGE =
  "Sleeps on the TestClock never fire without `TestClock.adjust`; this test can only time out.";
const MIXED_CLOCK_MESSAGE =
  "`setTimeout` is wall-clock while `Effect.sleep` here is TestClock; they never meet.";

type Tester = "effect" | "live" | "plain";

interface CalleeChain {
  readonly root: string;
  readonly members: ReadonlyArray<string>;
  readonly calls: ReadonlyArray<ESTree.CallExpression>;
}

// Flattens `it.live.skipIf(cond)` or `it.layer(L, opts)` into the root name, the member
// names, and the curried calls whose arguments carry options like `excludeTestServices`.
const calleeChain = (callee: unknown): Option.Option<CalleeChain> => {
  const members: Array<string> = [];
  const calls: Array<ESTree.CallExpression> = [];
  let current = unwrapExpression(callee);
  while (Option.isSome(current)) {
    const node = current.value;
    if (node.type === "Identifier") {
      return Option.some({ root: node.name, members: members.toReversed(), calls });
    }
    if (node.type === "CallExpression") {
      calls.push(node);
      current = unwrapExpression(node.callee);
      continue;
    }
    if (node.type === "MemberExpression") {
      const name = getPropertyName(node.property);
      if (Option.isNone(name)) return Option.none();
      members.push(name.value);
      current = unwrapExpression(node.object);
      continue;
    }
    return Option.none();
  }
  return Option.none();
};

const isLayerBlock = (chain: CalleeChain) =>
  chain.root === "layer" || (TESTER_ROOTS.has(chain.root) && chain.members.includes("layer"));

const testerKind = (chain: CalleeChain): Option.Option<Tester> => {
  if (!TESTER_ROOTS.has(chain.root) || chain.members.includes("layer")) return Option.none();
  if (chain.members.includes("live") || chain.members.includes("scopedLive")) {
    return Option.some("live");
  }
  if (chain.members.includes("effect") || chain.members.includes("scoped")) {
    return Option.some("effect");
  }
  return Option.some("plain");
};

const excludesTestServices = (chain: CalleeChain) =>
  chain.calls.some((call) =>
    call.arguments.some((argument) => {
      const expression = unwrapExpression(argument);
      if (Option.isNone(expression) || expression.value.type !== "ObjectExpression") return false;
      return expression.value.properties.some((property) => {
        if (property.type !== "Property") return false;
        const key = getPropertyName(property.key);
        const value = unwrapExpression(property.value);
        return (
          Option.isSome(key) &&
          key.value === "excludeTestServices" &&
          Option.isSome(value) &&
          value.value.type === "Literal" &&
          value.value.value === true
        );
      });
    }),
  );

// The clock a call runs on: the nearest enclosing test call decides, and an enclosing
// `it.layer(_, { excludeTestServices: true })` block strips the TestClock from `it.effect`.
const enclosingTester = (node: ESTree.Node): Option.Option<Tester> => {
  let child: ESTree.Node = node;
  let current = node.parent;
  let tester: Option.Option<Tester> = Option.none();
  while (current) {
    if (
      current.type === "CallExpression" &&
      current.arguments.some((argument) => argument === child)
    ) {
      const chain = calleeChain(current.callee);
      if (Option.isSome(chain)) {
        if (Option.isNone(tester)) {
          tester = testerKind(chain.value);
          if (Option.isSome(tester) && tester.value !== "effect") return tester;
        } else if (isLayerBlock(chain.value) && excludesTestServices(chain.value)) {
          return Option.some("live");
        }
      }
    }
    child = current;
    current = current.parent;
  }
  return tester;
};

const memberCallName = (callee: unknown): Option.Option<readonly [string, string]> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }
  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property) || Option.isNone(object) || object.value.type !== "Identifier") {
    return Option.none();
  }
  return Option.some([object.value.name, property.value] as const);
};

const LOOPS = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

// `while (...) { yield* Effect.sleep(...) }`: a statement of the loop body itself, not a
// conditional delay inside it.
const isPollingLoopStep = (node: ESTree.Node): boolean => {
  let statement: ESTree.Node | null = node.parent;
  while (statement && statement.type !== "ExpressionStatement") {
    if (FUNCTIONS.has(statement.type)) return false;
    statement = statement.parent;
  }
  const block = statement?.parent;
  if (!block) return false;
  if (LOOPS.has(block.type)) return true;
  return block.type === "BlockStatement" && block.parent !== null && LOOPS.has(block.parent.type);
};

const isPromiseExecutor = (fn: ESTree.Node) => {
  const parent = fn.parent;
  return (
    parent?.type === "NewExpression" &&
    parent.arguments[0] === fn &&
    isIdentifier(unwrapExpression(parent.callee), "Promise")
  );
};

const isInsidePromiseExecutor = (node: ESTree.Node): boolean => {
  let current = node.parent;
  while (current) {
    if (FUNCTIONS.has(current.type)) return isPromiseExecutor(current);
    current = current.parent;
  }
  return false;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow real-clock waits in tests; await the milestone or drive the TestClock instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};
    let drivesTestClock = false;
    // Whether the file drives the TestClock is only known after the whole file is walked.
    const untilDrivenReports: Array<{ node: ESTree.Node; message: string }> = [];
    const timerPromiseLocals = new Set<string>();
    const timerPromiseNamespaces = new Set<string>();

    const isTimerPromiseCall = (callee: unknown) => {
      const expression = unwrapExpression(callee);
      if (Option.isNone(expression)) return false;
      if (expression.value.type === "Identifier") {
        return timerPromiseLocals.has(expression.value.name);
      }
      return Option.match(memberCallName(callee), {
        onNone: () => false,
        onSome: ([object, property]) =>
          timerPromiseNamespaces.has(object) && TIMER_FUNCTIONS.has(property),
      });
    };

    const isCallbackTimer = (callee: unknown) => {
      const expression = unwrapExpression(callee);
      return (
        Option.isSome(expression) &&
        expression.value.type === "Identifier" &&
        TIMER_FUNCTIONS.has(expression.value.name) &&
        !timerPromiseLocals.has(expression.value.name)
      );
    };

    return {
      ImportDeclaration(node) {
        if (!TIMER_PROMISES_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            timerPromiseNamespaces.add(specifier.local.name);
          } else if (specifier.type === "ImportSpecifier") {
            const imported = getPropertyName(specifier.imported);
            if (Option.isSome(imported) && TIMER_FUNCTIONS.has(imported.value)) {
              timerPromiseLocals.add(specifier.local.name);
            }
          }
        }
      },
      CallExpression(node) {
        const reportFor = (message: string) => context.report({ node: node.callee, message });

        if (
          isTimerPromiseCall(node.callee) ||
          (isCallbackTimer(node.callee) && isInsidePromiseExecutor(node))
        ) {
          const tester = enclosingTester(node);
          reportFor(
            Option.isSome(tester) && tester.value === "effect"
              ? `${REAL_CLOCK_MESSAGE} ${MIXED_CLOCK_MESSAGE}`
              : REAL_CLOCK_MESSAGE,
          );
          return;
        }

        const name = memberCallName(node.callee);
        if (Option.isNone(name)) return;
        const [object, property] = name.value;
        if (object === "TestClock" && TEST_CLOCK_DRIVERS.has(property)) {
          drivesTestClock = true;
          return;
        }
        const isSleep = object === "Effect" && property === "sleep";
        const isWait =
          isSleep ||
          (object === "Effect" && property === "delay") ||
          (object === "Schedule" && SCHEDULE_WAITS.has(property));
        if (!isWait) return;

        const tester = enclosingTester(node);
        if (Option.isNone(tester)) {
          // A shared helper can serve TestClock tests, so only report it when nothing in
          // the file drives the TestClock or it polls in a loop, which only a real clock ends.
          if (isPollingLoopStep(node)) {
            reportFor(REAL_CLOCK_MESSAGE);
          } else {
            untilDrivenReports.push({ node: node.callee, message: REAL_CLOCK_MESSAGE });
          }
          return;
        }
        if (tester.value !== "effect") {
          reportFor(REAL_CLOCK_MESSAGE);
        } else if (isSleep) {
          untilDrivenReports.push({ node: node.callee, message: UNDRIVEN_TEST_CLOCK_MESSAGE });
        }
      },
      "Program:exit"() {
        if (drivesTestClock) return;
        for (const report of untilDrivenReports) context.report(report);
      },
    };
  },
});
