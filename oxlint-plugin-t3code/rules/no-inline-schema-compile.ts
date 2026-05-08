import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// Effect Schema decoder/encoder APIs allocate compiled functions. Keep them
// outside function bodies so hot paths do not rebuild compilers per call.
const COMPILER_METHODS = new Set<keyof typeof Schema>([
  "is",
  "asserts",
  "decodeEffect",
  "decodeExit",
  "decodeOption",
  "decodePromise",
  "decodeSync",
  "decodeUnknownExit",
  "decodeUnknownEffect",
  "decodeUnknownOption",
  "decodeUnknownPromise",
  "decodeUnknownSync",

  "encodeExit",
  "encodeEffect",
  "encodeOption",
  "encodePromise",
  "encodeSync",
  "encodeUnknownExit",
  "encodeUnknownEffect",
  "encodeUnknownOption",
  "encodeUnknownPromise",
  "encodeUnknownSync",
]);

const getSchemaCompilerMethod = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }

  const object = unwrapExpression(expression.value.object);
  if (!isIdentifier(object, "Schema")) return Option.none();

  return Option.filter(getPropertyName(expression.value.property), (method) =>
    COMPILER_METHODS.has(method as keyof typeof Schema),
  );
};

const isStaticSchemaReference = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return false;

  if (expression.value.type === "Identifier") {
    const [firstChar] = expression.value.name;
    return firstChar !== undefined && firstChar.toUpperCase() === firstChar;
  }

  return expression.value.type === "MemberExpression";
};

const isNestedStaticSchemaCall = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "CallExpression") return false;

  const callee = unwrapExpression(expression.value.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return false;

  const object = unwrapExpression(callee.value.object);
  if (!isIdentifier(object, "Schema")) return false;

  const method = getPropertyName(callee.value.property);
  if (Option.isSome(method) && method.value === "fromJsonString") {
    const firstArg = expression.value.arguments[0];
    return isStaticSchemaReference(firstArg) || isNestedStaticSchemaCall(firstArg);
  }

  return true;
};

const isImmediatelyInvoked = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return false;

  const parent =
    "parent" in expression.value ? unwrapExpression(expression.value.parent) : Option.none();
  return (
    Option.isSome(parent) &&
    parent.value.type === "CallExpression" &&
    unwrapExpression(parent.value.callee).pipe(
      Option.exists((callee) => callee === expression.value),
    )
  );
};

const messageHigh = (method: string) =>
  `Hoist Schema.${method}(...) to module scope: both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const.`;

const messageMedium = (method: string) =>
  `Hoist Schema.${method}(...) to module scope: the compiled function is rebuilt on every call. Move it to a module-level const.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Schema decoder/encoder compiler calls inside function bodies; hoist them to module scope.",
    },
  },
  createOnce(context) {
    let functionDepth = 0;

    const resetFunctionDepth = () => {
      functionDepth = 0;
    };

    const enterFunction = () => {
      functionDepth++;
    };

    const exitFunction = () => {
      functionDepth--;
    };

    return {
      before: resetFunctionDepth,
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CallExpression(node) {
        if (functionDepth === 0) return;

        const method = getSchemaCompilerMethod(node.callee);
        if (Option.isNone(method)) return;
        if (!isImmediatelyInvoked(node)) return;

        const firstArg = node.arguments[0];
        const high = firstArg && isNestedStaticSchemaCall(firstArg);
        if (!high && !isStaticSchemaReference(firstArg)) return;

        context.report({
          node: node.callee,
          message: high ? messageHigh(method.value) : messageMedium(method.value),
        });
      },
    };
  },
});
