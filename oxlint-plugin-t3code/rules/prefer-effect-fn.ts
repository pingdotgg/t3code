import { defineRule, type ESTree } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Use Effect.fn for reusable generator-based Effect functions.",
    },
  },
  create(context) {
    const isEffectImport = (identifier: ESTree.IdentifierReference, member: string) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable.defs.some((def) => {
            if (def.type !== "ImportBinding" || def.parent?.type !== "ImportDeclaration") {
              return false;
            }
            const source = def.parent.source.value;
            if (source === "effect/Effect") {
              if (member === "") {
                return (
                  def.node.type === "ImportSpecifier" &&
                  (def.node.imported.type === "Identifier"
                    ? def.node.imported.name
                    : def.node.imported.value) === "gen"
                );
              }
              return def.node.type === "ImportNamespaceSpecifier";
            }
            return (
              source === "effect" &&
              def.node.type === "ImportSpecifier" &&
              (def.node.imported.type === "Identifier"
                ? def.node.imported.name
                : def.node.imported.value) === "Effect"
            );
          });
        }
        if (scope.upper === null) return false;
        scope = scope.upper;
      }
    };

    const isGeneratorCall = (expression: ESTree.Expression): boolean => {
      if (expression.type !== "CallExpression") return false;
      const callee = expression.callee;
      if (callee.type === "Identifier") return isEffectImport(callee, "");
      if (callee.type !== "MemberExpression" || callee.computed) return false;
      if (callee.property.type !== "Identifier") return false;
      if (callee.property.name === "pipe") return isGeneratorCall(callee.object);
      return (
        callee.property.name === "gen" &&
        callee.object.type === "Identifier" &&
        isEffectImport(callee.object, "gen")
      );
    };

    const check = (node: ESTree.ArrowFunctionExpression | ESTree.Function) => {
      if (node.async || node.generator) return;
      const parent = node.parent;
      if (node.type !== "FunctionDeclaration") {
        if (parent.type === "MethodDefinition") {
          if (parent.kind !== "method") return;
        } else if (parent.type === "Property") {
          if (parent.kind !== "init") return;
          const name =
            parent.key.type === "Identifier"
              ? parent.key.name
              : parent.key.type === "Literal"
                ? parent.key.value
                : undefined;
          const call = parent.parent.parent;
          if (call?.type === "CallExpression") {
            let callee = call.callee;
            while (callee.type === "CallExpression") callee = callee.callee;
            if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
              if (
                ["catchTags", "match", "matchEffect", "matchCauseEffect"].includes(
                  callee.property.name,
                ) ||
                (name === "defaultValue" && callee.property.name === "Reference")
              ) {
                return;
              }
            }
          }
        } else if (parent.type !== "VariableDeclarator" && parent.type !== "PropertyDefinition") {
          return;
        }
      }
      const body = node.body;
      if (body === null) return;
      let expression: ESTree.Expression | null;
      if (body.type === "BlockStatement") {
        if (body.body.length !== 1 || body.body[0]?.type !== "ReturnStatement") return;
        expression = body.body[0].argument;
      } else {
        expression = body;
      }
      if (expression === null || !isGeneratorCall(expression)) return;
      context.report({
        node,
        message:
          'Use Effect.fn("Service.operation") for reusable Effect functions. Reserve Effect.fnUntraced for documented hot paths or an existing span; keep Effect.gen for inline programs.',
      });
    };

    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
      FunctionDeclaration: check,
    };
  },
});
