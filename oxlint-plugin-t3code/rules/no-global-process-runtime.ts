import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const RUNTIME_PROPERTIES = new Set(["platform", "arch"]);
const HOST_PROCESS_REFERENCE_FILE = "packages/shared/src/hostProcess.ts";
const NODE_OS_MODULES = new Set(["node:os", "os"]);

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const toRepoPath = (filename: string, cwd: string) => {
  const normalizedFilename = normalizePath(filename);
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  const prefix = `${normalizedCwd}/`;
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename;
};

const isHostProcessReferenceFile = (filename: string, cwd: string) =>
  toRepoPath(filename, cwd) === HOST_PROCESS_REFERENCE_FILE;

const isGlobalProcessObject = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, "process")) return true;
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;

  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  return (
    isIdentifier(object, "globalThis") && Option.isSome(property) && property.value === "process"
  );
};

const message = (property: string) =>
  `Use HostProcess${property === "arch" ? "Architecture" : "Platform"} instead of process.${property}; inject the runtime reference in Effect code and provide it explicitly in tests.`;

const getLiteralStringValue = (node: unknown): Option.Option<string> => {
  if (typeof node !== "object" || node === null) return Option.none();
  if (!("type" in node) || node.type !== "Literal") return Option.none();
  if (!("value" in node) || typeof node.value !== "string") return Option.none();
  return Option.some(node.value);
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct host runtime platform/architecture reads outside the shared host process references.",
    },
  },
  createOnce(context) {
    const nodeOsNamespaces = new Set<string>();
    const nodeOsRuntimeImports = new Map<string, string>();

    const resetBindings = () => {
      nodeOsNamespaces.clear();
      nodeOsRuntimeImports.clear();
    };

    const trackImportDeclaration = (node: unknown) => {
      if (typeof node !== "object" || node === null) return;
      if (!("source" in node)) return;

      const source = getLiteralStringValue(node.source);
      if (Option.isNone(source) || !NODE_OS_MODULES.has(source.value)) return;
      if (!("specifiers" in node) || !Array.isArray(node.specifiers)) return;

      for (const specifier of node.specifiers) {
        if (typeof specifier !== "object" || specifier === null) continue;
        if (!("local" in specifier)) continue;

        const local = unwrapExpression(specifier.local);
        if (Option.isNone(local) || local.value.type !== "Identifier") continue;
        const localName = local.value.name;

        if (
          specifier.type === "ImportNamespaceSpecifier" ||
          specifier.type === "ImportDefaultSpecifier"
        ) {
          nodeOsNamespaces.add(localName);
          continue;
        }

        if (specifier.type !== "ImportSpecifier" || !("imported" in specifier)) continue;

        const imported = getPropertyName(specifier.imported);
        if (Option.isSome(imported) && RUNTIME_PROPERTIES.has(imported.value)) {
          nodeOsRuntimeImports.set(localName, imported.value);
        }
      }
    };

    const getNodeOsRuntimeCall = (callee: unknown): Option.Option<string> => {
      const expression = unwrapExpression(callee);
      if (Option.isNone(expression)) return Option.none();

      if (expression.value.type === "Identifier") {
        const property = nodeOsRuntimeImports.get(expression.value.name);
        return property === undefined ? Option.none() : Option.some(property);
      }

      if (expression.value.type !== "MemberExpression") return Option.none();

      const object = unwrapExpression(expression.value.object);
      if (Option.isNone(object) || object.value.type !== "Identifier") return Option.none();
      if (!nodeOsNamespaces.has(object.value.name)) return Option.none();

      return Option.filter(getPropertyName(expression.value.property), (property) =>
        RUNTIME_PROPERTIES.has(property),
      );
    };

    return {
      before: resetBindings,
      ImportDeclaration: trackImportDeclaration,
      MemberExpression(node) {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return;

        const property = getPropertyName(node.property);
        if (Option.isNone(property) || !RUNTIME_PROPERTIES.has(property.value)) return;
        if (!isGlobalProcessObject(node.object)) return;

        context.report({
          node,
          message: message(property.value),
        });
      },
      CallExpression(node) {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return;

        const property = getNodeOsRuntimeCall(node.callee);
        if (Option.isNone(property)) return;

        context.report({
          node,
          message: message(property.value),
        });
      },
    };
  },
});
