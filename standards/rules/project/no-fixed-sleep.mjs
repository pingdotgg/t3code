/*
Adapted from https://github.com/interfere-inc/landmines
Revision: 2536897dfd8cd57fb33b1eeadbb42b58a7f9de13
Copyright (c) 2026 Interfere, Inc.
MIT license: ./landmines.LICENSE
*/
const defaultRunNow = ["act", "waitFor", "then", "catch", "finally", "step"];

const testCallees = new Set(["test", "it", "beforeEach", "afterEach", "beforeAll", "afterAll"]);

const timerModules = new Set(["node:timers/promises", "timers/promises"]);

function isMember(node, object, property) {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === object &&
    node.property.type === "Identifier" &&
    !node.computed &&
    node.property.name === property
  );
}

function isSetTimeout(node) {
  return (
    (node.type === "Identifier" && node.name === "setTimeout") ||
    isMember(node, "globalThis", "setTimeout") ||
    isMember(node, "window", "setTimeout")
  );
}

const calleeRoot = (node) => {
  if (node.type === "CallExpression") {
    return calleeRoot(node.callee);
  }

  if (node.type === "MemberExpression") {
    return calleeRoot(node.object);
  }

  if (node.type === "TaggedTemplateExpression") {
    return calleeRoot(node.tag);
  }

  return node.type === "Identifier" ? node.name : undefined;
};

function calleeName(node) {
  if (node.type === "Identifier") {
    return node.name;
  }

  return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : undefined;
}

const inTestBody = (node, runNow) => {
  let current = node.parent;

  while (
    current &&
    current.type !== "ArrowFunctionExpression" &&
    current.type !== "FunctionExpression" &&
    current.type !== "FunctionDeclaration"
  ) {
    current = current.parent;
  }

  const call = current?.parent;

  if (call?.type !== "CallExpression") {
    return false;
  }

  if (testCallees.has(calleeRoot(call.callee) ?? "")) {
    return true;
  }

  return runNow.has(calleeName(call.callee) ?? "") && inTestBody(call, runNow);
};

function scheduled(body) {
  if (body?.type !== "BlockStatement") {
    return body;
  }

  const [statement, ...rest] = body.body;

  return statement?.type === "ExpressionStatement" && rest.length === 0
    ? statement.expression
    : null;
}

function resolvesAfterTimeout(node) {
  const [executor] = node.arguments;

  if (
    !executor ||
    (executor.type !== "ArrowFunctionExpression" && executor.type !== "FunctionExpression")
  ) {
    return false;
  }

  const [resolve] = executor.params;

  if (resolve?.type !== "Identifier") {
    return false;
  }

  const call = scheduled(executor.body);

  if (call?.type !== "CallExpression" || !isSetTimeout(call.callee)) {
    return false;
  }

  const [handler] = call.arguments;

  if (handler?.type === "Identifier") {
    return handler.name === resolve.name;
  }

  if (handler?.type !== "ArrowFunctionExpression" && handler?.type !== "FunctionExpression") {
    return false;
  }

  const settle = scheduled(handler.body);

  return (
    settle?.type === "CallExpression" &&
    settle.callee.type === "Identifier" &&
    settle.callee.name === resolve.name
  );
}

const noFixedSleep = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          runNow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    docs: {
      description: "Disallow awaiting a fixed real-time sleep in a test or hook body.",
    },
    messages: {
      sleep:
        "Replace this fixed sleep with a signal: await the operation itself or a promise its handler resolves. To move time, use vi.useFakeTimers() and advance it. A sleep guesses how long real work takes and fails under CPU load.",
    },
  },
  create(context) {
    const [options] = context.options;
    const runNow = new Set(options?.runNow ?? defaultRunNow);
    const timers = new Set();
    const sleeps = [];
    let fakeTimers = false;

    function isSleep(node) {
      if (node.type === "NewExpression") {
        return (
          node.callee.type === "Identifier" &&
          node.callee.name === "Promise" &&
          resolvesAfterTimeout(node)
        );
      }

      if (node.type !== "CallExpression") {
        return false;
      }

      return (
        (node.callee.type === "Identifier" && timers.has(node.callee.name)) ||
        isMember(node.callee, "scheduler", "wait") ||
        isMember(node.callee, "Bun", "sleep")
      );
    }

    return {
      ImportDeclaration(node) {
        if (!timerModules.has(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "setTimeout"
          ) {
            timers.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (isMember(node.callee, "vi", "useFakeTimers")) {
          fakeTimers = true;
        }
      },
      AwaitExpression(node) {
        if (isSleep(node.argument) && inTestBody(node, runNow)) {
          sleeps.push(node);
        }
      },
      "Program:exit"() {
        if (!fakeTimers) {
          for (const node of sleeps) context.report({ node, messageId: "sleep" });
        }
      },
    };
  },
};
export default { rules: { "no-fixed-sleep": noFixedSleep } };
