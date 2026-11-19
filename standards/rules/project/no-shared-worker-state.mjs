/**
 * Flags process-wide state that outlives a test file in a shared Vitest worker (`isolate: false`):
 * module mocks, stubbed globals and env, process.env writes, configured process-wide calls, and
 * spies a helper installs as it loads. *.isolated files get a fresh worker and are skipped.
 */

const VITEST_STATE_METHODS = new Set(["mock", "doMock", "stubGlobal", "stubEnv"]);
const ISOLATED_FILE = /\.isolated(\.test)?\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function propertyName(member) {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (
    member.computed &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return null;
}

function memberCallName(callee) {
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") {
    return null;
  }
  const property = propertyName(callee);
  return property === null ? null : `${callee.object.name}.${property}`;
}

function calleeName(callee) {
  return callee.type === "Identifier" ? callee.name : memberCallName(callee);
}

function isProcessEnv(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    propertyName(node) === "env"
  );
}

function writesProcessEnv(target) {
  return (
    isProcessEnv(target) || (target?.type === "MemberExpression" && isProcessEnv(target.object))
  );
}

function runsWhenModuleLoads(node) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (FUNCTION_TYPES.has(ancestor.type)) return false;
  }
  return true;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow process-wide state in test files and helpers that share a Vitest worker.",
    },
    schema: [
      {
        type: "object",
        properties: {
          processWideCalls: {
            type: "array",
            items: { type: "string" },
          },
          allowPatterns: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      testState:
        "{{what}} outlives this file in a shared Vitest worker. Restructure the test, or rename the file to *.isolated.test.ts so it runs in a fresh worker.",
      helperState:
        "{{what}} in a test helper outlives every file that imports it in a shared Vitest worker. Move it into the tests that need it, or rename the helper to *.isolated.ts.",
      helperSpy:
        "A spy installed as this helper loads is restored when the first importing file ends, and the cached helper does not install it again. Install it in a hook or a test, or rename the helper to *.isolated.ts.",
      isolatedImport:
        "{{source}} leaves process-wide state behind, so only isolated files may import it. Rename this file to *.isolated.test.ts, or *.isolated.ts for a helper.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    const option = context.options[0] ?? {};
    const allowPatterns = (option.allowPatterns ?? []).map((pattern) => new RegExp(pattern));
    if (ISOLATED_FILE.test(filename) || allowPatterns.some((pattern) => pattern.test(filename))) {
      return {};
    }
    const processWideCalls = new Set(option.processWideCalls ?? []);
    const isTestFile = TEST_FILE.test(filename);

    function report(node, what) {
      context.report({
        node,
        messageId: isTestFile ? "testState" : "helperState",
        data: { what },
      });
    }

    function checkImportSource(source) {
      if (
        source?.type === "Literal" &&
        typeof source.value === "string" &&
        ISOLATED_FILE.test(source.value)
      ) {
        context.report({
          node: source,
          messageId: "isolatedImport",
          data: { source: source.value },
        });
      }
    }

    return {
      ImportDeclaration(node) {
        checkImportSource(node.source);
      },
      ImportExpression(node) {
        checkImportSource(node.source);
      },
      ExportNamedDeclaration(node) {
        checkImportSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkImportSource(node.source);
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null) return;
        const [object, method] = name.split(".");
        if (object === "vi" && VITEST_STATE_METHODS.has(method)) {
          report(node, `\`${name}()\``);
        } else if (processWideCalls.has(name)) {
          report(node, `\`${name}()\``);
        } else if (name === "Object.assign" && isProcessEnv(node.arguments[0])) {
          report(node, "A process.env write");
        } else if (!isTestFile && name === "vi.spyOn" && runsWhenModuleLoads(node)) {
          context.report({ node, messageId: "helperSpy" });
        }
      },
      AssignmentExpression(node) {
        if (writesProcessEnv(node.left)) report(node, "A process.env write");
      },
      UnaryExpression(node) {
        if (node.operator === "delete" && writesProcessEnv(node.argument)) {
          report(node, "A process.env write");
        }
      },
    };
  },
};

export default {
  rules: {
    "no-shared-worker-state": rule,
  },
};
