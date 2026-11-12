import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const MCP_SERVER_MODULE = "effect/ai/McpServer";
const AI_MODULES = new Set(["effect/ai", "effect/ai/index"]);
const MODULE_REGISTRATIONS = new Set([
  "toolkit",
  "registerToolkit",
  "resource",
  "registerResource",
  "prompt",
  "registerPrompt",
]);
const SERVICE_REGISTRATIONS = new Set([
  "addTool",
  "addResource",
  "addResourceTemplate",
  "addPrompt",
]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const HOW =
  "Build the handlers with McpToolAccess.toLayer and register them through McpHttpServer's toolkitRegistration.";
const registrationMessage = (name: string) =>
  `${name} registers on /mcp without the access checks McpToolAccess declares. ${HOW}`;
const importMessage = `Only McpHttpServer may use Effect's McpServer: a registration anywhere else skips the access checks McpToolAccess declares. ${HOW}`;
const testImportMessage =
  'Tests import McpServer only as `import { McpServer } from "effect/ai"`, so a registration on it is reported.';

const literalString = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) => {
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return Option.some(expression.value);
    }
    if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
      return Option.fromNullishOr(expression.quasis[0]?.value.cooked);
    }
    return Option.none();
  });

const namesMcpServer = (node: unknown) =>
  Option.getOrUndefined(getPropertyName(node)) === "McpServer";

const exposesMcpServer = (source: Option.Option<string>) =>
  Option.isSome(source) && (source.value === MCP_SERVER_MODULE || AI_MODULES.has(source.value));

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow registering on the MCP server without McpToolAccess; tools must declare who may call them.",
    },
  },
  create(context) {
    const isTest = TEST_FILE_PATTERN.test(context.filename);
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const source = literalString(node.source);
        if (Option.isNone(source)) return;
        const exposes = node.specifiers.some((specifier) => {
          if (specifier.type !== "ImportSpecifier") return exposesMcpServer(source);
          if (specifier.importKind === "type") return false;
          if (source.value === MCP_SERVER_MODULE) return true;
          return (
            AI_MODULES.has(source.value) &&
            namesMcpServer(specifier.imported) &&
            !(isTest && namesMcpServer(specifier.local))
          );
        });
        if (exposes) context.report({ node, message: isTest ? testImportMessage : importMessage });
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.exportKind === "type") return;
        const source = literalString(node.source);
        if (Option.isNone(source)) return;
        const exposes = node.specifiers.some(
          (specifier) =>
            specifier.exportKind !== "type" &&
            (source.value === MCP_SERVER_MODULE ||
              (AI_MODULES.has(source.value) && namesMcpServer(specifier.local))),
        );
        if (exposes) context.report({ node, message: importMessage });
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        if (exposesMcpServer(literalString(node.source))) {
          context.report({ node, message: importMessage });
        }
      },
      ImportExpression(node) {
        if (exposesMcpServer(literalString(node.source))) {
          context.report({ node, message: importMessage });
        }
      },
      MemberExpression(node) {
        const name = getPropertyName(node.property);
        if (Option.isNone(name)) return;
        if (SERVICE_REGISTRATIONS.has(name.value)) {
          context.report({ node, message: registrationMessage(`.${name.value}`) });
        } else if (
          MODULE_REGISTRATIONS.has(name.value) &&
          isIdentifier(unwrapExpression(node.object), "McpServer")
        ) {
          context.report({ node, message: registrationMessage(`McpServer.${name.value}`) });
        }
      },
      ObjectPattern(node) {
        const fromMcpServer =
          node.parent.type === "VariableDeclarator" &&
          isIdentifier(unwrapExpression(node.parent.init), "McpServer");
        for (const property of node.properties) {
          if (property.type !== "Property") continue;
          const name = getPropertyName(property.key);
          if (Option.isNone(name)) continue;
          if (SERVICE_REGISTRATIONS.has(name.value)) {
            context.report({ node: property, message: registrationMessage(`.${name.value}`) });
          } else if (fromMcpServer && MODULE_REGISTRATIONS.has(name.value)) {
            context.report({
              node: property,
              message: registrationMessage(`McpServer.${name.value}`),
            });
          }
        }
      },
    };
  },
});
