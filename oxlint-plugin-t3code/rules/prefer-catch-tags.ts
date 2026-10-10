import { defineRule, type ESTree } from "@oxlint/plugins";

const MESSAGE = "Catch known tags with `Effect.catchTags({ Tag: handler })`, even for one tag.";

/** Reports `Effect.catchTag`, through any namespace import of `effect/Effect` or a named import. */
export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Require `Effect.catchTags` over `Effect.catchTag`.",
    },
  },
  create(context) {
    // Whether `identifier` is bound by `import * as X from "effect/Effect"`, not a shadowing local.
    const isEffectNamespace = (identifier: ESTree.IdentifierReference) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable.defs.some(
            (def) =>
              def.type === "ImportBinding" &&
              def.node.type === "ImportNamespaceSpecifier" &&
              def.parent?.type === "ImportDeclaration" &&
              def.parent.source.value === "effect/Effect",
          );
        }
        if (scope.upper === null) return false;
        scope = scope.upper;
      }
    };

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect/Effect") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            (specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value) === "catchTag"
          ) {
            context.report({ node: specifier, message: MESSAGE });
          }
        }
      },
      MemberExpression(node) {
        if (
          !node.computed &&
          node.object.type === "Identifier" &&
          node.property.type === "Identifier" &&
          node.property.name === "catchTag" &&
          isEffectNamespace(node.object)
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
