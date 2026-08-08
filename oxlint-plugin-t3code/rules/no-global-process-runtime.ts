import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const RUNTIME_PROPERTIES = new Set(["platform", "arch"]);
const HOST_PROCESS_REFERENCE_FILE = "packages/shared/src/hostProcess.ts";
const NODE_OS_MODULES = new Set(["node:os", "os"]);
const NODE_PROCESS_MODULES = new Set(["node:process", "process"]);

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

// A binding (function param, local var/let/const, catch param) with the same
// name as a tracked namespace import shadows it lexically, so a reference to
// that name no longer resolves to the import. @oxlint/plugins declares a
// scope API in its types but doesn't actually export it at runtime (only
// definePlugin/defineRule/eslintCompatPlugin are exported), so we walk
// `.parent` — present on every node — instead of resolving bindings via scope.
const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const BLOCK_NODE_TYPES = new Set(["BlockStatement", "FunctionBody", "Program"]);

const collectBindingNames = (pattern: unknown, names: Set<string>): void => {
  if (typeof pattern !== "object" || pattern === null || !("type" in pattern)) return;
  const node = pattern as { type: unknown };
  switch (node.type) {
    case "Identifier":
    case "BindingIdentifier": {
      const name = (node as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
      return;
    }
    case "ObjectPattern": {
      const properties = (node as { properties?: unknown }).properties;
      if (Array.isArray(properties))
        for (const property of properties) collectBindingNames(property, names);
      return;
    }
    // Oxlint's `BindingProperty` interface carries the runtime tag "Property",
    // so "BindingProperty" never appears in the AST. Match both, as the
    // Identifier and RestElement cases above already do.
    case "Property":
    case "BindingProperty":
      collectBindingNames((node as { value?: unknown }).value, names);
      return;
    case "ArrayPattern": {
      const elements = (node as { elements?: unknown }).elements;
      if (Array.isArray(elements))
        for (const element of elements) collectBindingNames(element, names);
      return;
    }
    case "AssignmentPattern":
      collectBindingNames((node as { left?: unknown }).left, names);
      return;
    case "BindingRestElement":
    case "RestElement":
      collectBindingNames((node as { argument?: unknown }).argument, names);
      return;
    default:
      return;
  }
};

const statementsDeclare = (statements: unknown, name: string): boolean => {
  if (!Array.isArray(statements)) return false;
  for (const statement of statements) {
    if (typeof statement !== "object" || statement === null || !("type" in statement)) continue;
    const node = statement as { type: unknown };
    const names = new Set<string>();
    if (node.type === "VariableDeclaration") {
      const declarations = (node as { declarations?: unknown }).declarations;
      if (Array.isArray(declarations)) {
        for (const declarator of declarations)
          collectBindingNames((declarator as { id?: unknown }).id, names);
      }
    } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      collectBindingNames((node as { id?: unknown }).id, names);
    }
    if (names.has(name)) return true;
  }
  return false;
};

// Walks up from `node` looking for a closer binding named `name` (function
// param, local var/let/const, or catch param) that would shadow an
// module-scope import of that name.
const isShadowedByLocalBinding = (node: unknown, name: string): boolean => {
  let current =
    typeof node === "object" && node !== null ? (node as { parent?: unknown }).parent : undefined;

  while (typeof current === "object" && current !== null && "type" in current) {
    const ancestor = current as { type: unknown; parent?: unknown };

    if (typeof ancestor.type === "string" && FUNCTION_NODE_TYPES.has(ancestor.type)) {
      const params = (ancestor as { params?: unknown }).params;
      if (Array.isArray(params)) {
        for (const param of params) {
          const names = new Set<string>();
          collectBindingNames(param, names);
          if (names.has(name)) return true;
        }
      }
    } else if (ancestor.type === "CatchClause") {
      const param = (ancestor as { param?: unknown }).param;
      if (param !== null && param !== undefined) {
        const names = new Set<string>();
        collectBindingNames(param, names);
        if (names.has(name)) return true;
      }
    } else if (typeof ancestor.type === "string" && BLOCK_NODE_TYPES.has(ancestor.type)) {
      if (statementsDeclare((ancestor as { body?: unknown }).body, name)) return true;
    }

    if (ancestor.type === "Program") break;
    current = ancestor.parent;
  }

  return false;
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
    const nodeProcessNamespaces = new Set<string>();

    const resetBindings = () => {
      nodeOsNamespaces.clear();
      nodeOsRuntimeImports.clear();
      nodeProcessNamespaces.clear();
    };

    const trackImportDeclaration = (node: unknown) => {
      if (typeof node !== "object" || node === null) return;
      if (!("source" in node)) return;

      const source = getLiteralStringValue(node.source);
      if (Option.isNone(source)) return;
      const isNodeOsModule = NODE_OS_MODULES.has(source.value);
      const isNodeProcessModule = NODE_PROCESS_MODULES.has(source.value);
      if (!isNodeOsModule && !isNodeProcessModule) return;
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
          if (isNodeProcessModule) {
            nodeProcessNamespaces.add(localName);
          } else {
            nodeOsNamespaces.add(localName);
          }
          continue;
        }

        if (!isNodeOsModule) continue;
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
        if (property === undefined) return Option.none();
        if (isShadowedByLocalBinding(expression.value, expression.value.name)) return Option.none();
        return Option.some(property);
      }

      if (expression.value.type !== "MemberExpression") return Option.none();

      const object = unwrapExpression(expression.value.object);
      if (Option.isNone(object) || object.value.type !== "Identifier") return Option.none();
      if (!nodeOsNamespaces.has(object.value.name)) return Option.none();
      if (isShadowedByLocalBinding(object.value, object.value.name)) return Option.none();

      return Option.filter(getPropertyName(expression.value.property), (property) =>
        RUNTIME_PROPERTIES.has(property),
      );
    };

    const isProcessRuntimeObject = (node: unknown): boolean => {
      if (isGlobalProcessObject(node)) return true;

      const expression = unwrapExpression(node);
      return (
        Option.isSome(expression) &&
        expression.value.type === "Identifier" &&
        nodeProcessNamespaces.has(expression.value.name) &&
        !isShadowedByLocalBinding(expression.value, expression.value.name)
      );
    };

    return {
      before: resetBindings,
      ImportDeclaration: trackImportDeclaration,
      MemberExpression(node) {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return;

        const property = getPropertyName(node.property);
        if (Option.isNone(property) || !RUNTIME_PROPERTIES.has(property.value)) return;
        if (!isProcessRuntimeObject(node.object)) return;

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
