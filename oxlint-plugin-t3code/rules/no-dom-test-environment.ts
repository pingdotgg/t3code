import { defineRule, type ESTree } from "@oxlint/plugins";

const DOM_ENVIRONMENT_PACKAGE = /^(?:jsdom|happy-dom)(?:\/|$)/u;
const MESSAGE =
  "Select test environments in Vitest project configuration instead of a per-file pragma or a DOM emulator import. Web DOM tests belong in *.browser.test.{ts,tsx}.";

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Reject per-file Vitest environments and DOM emulator imports." },
  },
  create(context) {
    const checkImport = (source: ESTree.Node | null) => {
      if (source === null) return;
      const value =
        source.type === "Literal"
          ? source.value
          : source.type === "TemplateLiteral" && source.expressions.length === 0
            ? source.quasis[0]?.value.cooked
            : undefined;
      if (typeof value === "string" && DOM_ENVIRONMENT_PACKAGE.test(value)) {
        context.report({ node: source, message: MESSAGE });
      }
    };

    return {
      Program() {
        const index = context.sourceCode.text.indexOf("@vitest-environment");
        if (index !== -1) {
          context.report({ loc: context.sourceCode.getLocFromIndex(index), message: MESSAGE });
        }
      },
      ImportDeclaration: (node) => checkImport(node.source),
      ImportExpression: (node) => checkImport(node.source),
      ExportNamedDeclaration: (node) => checkImport(node.source),
      ExportAllDeclaration: (node) => checkImport(node.source),
      TSExternalModuleReference: (node) => checkImport(node.expression),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          checkImport(node.arguments[0] ?? null);
        }
      },
    };
  },
});
