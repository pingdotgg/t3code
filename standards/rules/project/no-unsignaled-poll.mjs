/*
Adapted from https://github.com/interfere-inc/landmines
Revision: 2536897dfd8cd57fb33b1eeadbb42b58a7f9de13
Copyright (c) 2026 Interfere, Inc.
MIT license: ./landmines.LICENSE
*/
const spyMatchers =
  /^(?:toHaveBeenCalled|toHaveBeenCalledOnce|toHaveBeenCalledTimes|toHaveBeenCalledWith|toHaveBeenCalledExactlyOnceWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toHaveReturned|toHaveReturnedTimes|toHaveReturnedWith|toHaveLastReturnedWith|toHaveNthReturnedWith|toHaveResolved|toHaveResolvedTimes|toHaveResolvedWith|toHaveLastResolvedWith|toHaveNthResolvedWith)$/u;

function propertyName(node) {
  return node.property.type === "Identifier" && !node.computed ? node.property.name : undefined;
}

function isCall(node, object, property) {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === object &&
    propertyName(node) === property
  );
}

const path = (node) => {
  if (node.type === "ChainExpression") {
    return path(node.expression);
  }

  if (node.type === "Identifier") {
    return [node.name];
  }

  if (node.type !== "MemberExpression") {
    return null;
  }

  const object = path(node.object);

  return object && [...object, propertyName(node) ?? "[]"];
};

function readsRecorder(node) {
  const names = path(node);

  if (!names || names.includes("current")) {
    return false;
  }

  const last = names.at(-1);

  return names.includes("mock") || (names.length > 1 && (last === "length" || last === "size"));
}

function polledValue(callback) {
  if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
    return null;
  }

  if (!callback.body) {
    return null;
  }

  if (callback.body.type !== "BlockStatement") {
    return callback.body;
  }

  const [statement, ...rest] = callback.body.body;

  if (rest.length > 0) {
    return null;
  }

  if (statement?.type === "ReturnStatement") {
    return statement.argument;
  }

  return statement?.type === "ExpressionStatement" ? statement.expression : null;
}

function assertsRecorder(node) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") {
    return false;
  }

  const matcher = propertyName(node.callee) ?? "";

  const subject =
    node.callee.object.type === "MemberExpression" && propertyName(node.callee.object) === "not"
      ? node.callee.object.object
      : node.callee.object;

  if (
    subject.type !== "CallExpression" ||
    subject.callee.type !== "Identifier" ||
    subject.callee.name !== "expect"
  ) {
    return false;
  }

  const [target] = subject.arguments;

  if (!target || target.type === "SpreadElement") {
    return false;
  }

  if (readsRecorder(target)) {
    return true;
  }

  const names = path(target);

  return (
    names !== null &&
    !names.includes("current") &&
    (spyMatchers.test(matcher) || matcher === "toHaveLength")
  );
}

function pollsLength(node, value) {
  const { parent } = node;
  const names = path(value);
  const matcher = parent.type === "MemberExpression" ? (propertyName(parent) ?? "") : "";

  return (
    (matcher === "toHaveLength" || spyMatchers.test(matcher)) &&
    names !== null &&
    !names.includes("current")
  );
}

const noUnsignaledPoll = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow expect.poll and vi.waitFor on request recorders and spy state, which race a deadline instead of awaiting a signal.",
    },
    messages: {
      poll: "Await a signal instead of polling a request recorder or spy: resolve a Promise.withResolvers() deferred from the handler or callback that records it, then await its promise, or await the operation's own completion. A deadline-bound poll on a counter fails under CPU load, and a longer timeout only hides that.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const poll = isCall(node.callee, "expect", "poll");

        if (!poll && !isCall(node.callee, "vi", "waitFor")) {
          return;
        }

        const [callback] = node.arguments;
        const value = callback && polledValue(callback);

        if (!value) {
          return;
        }

        if (readsRecorder(value) || (poll ? pollsLength(node, value) : assertsRecorder(value))) {
          context.report({ node, messageId: "poll" });
        }
      },
    };
  },
};
export default { rules: { "no-unsignaled-poll": noUnsignaledPoll } };
