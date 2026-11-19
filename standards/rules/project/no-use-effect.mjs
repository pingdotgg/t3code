const MESSAGE =
  "Replace useEffect with render-time derivation, event handlers, framework data APIs, or useSyncExternalStore for external subscriptions.";

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow React useEffect in shipped UI code.",
    },
    schema: [],
    messages: {
      noUseEffect: MESSAGE,
    },
  },
  create(context) {
    const reactBindings = new Set();

    return {
      Program(node) {
        for (const statement of node.body) {
          if (statement.type !== "ImportDeclaration" || statement.source.value !== "react") {
            continue;
          }

          for (const specifier of statement.specifiers) {
            if (specifier.type === "ImportSpecifier" && specifier.imported.name === "useEffect") {
              context.report({ node: specifier, messageId: "noUseEffect" });
            } else if (
              specifier.type === "ImportDefaultSpecifier" ||
              specifier.type === "ImportNamespaceSpecifier"
            ) {
              reactBindings.add(specifier.local.name);
            }
          }
        }
      },
      MemberExpression(node) {
        if (
          !node.computed &&
          node.object.type === "Identifier" &&
          reactBindings.has(node.object.name) &&
          node.property.type === "Identifier" &&
          node.property.name === "useEffect"
        ) {
          context.report({ node, messageId: "noUseEffect" });
        }
      },
    };
  },
};

export default {
  rules: {
    "no-use-effect": rule,
  },
};
