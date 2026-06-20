import { defineRule } from "@oxlint/plugins";

const NODE_MODULE_ALIASES = new Map([
  ["assert/strict", "Assert"],
  ["fs/promises", "FSP"],
]);

const NODE_SEGMENT_ALIASES = new Map([
  ["fs", "FS"],
  ["os", "OS"],
  ["url", "URL"],
  ["vm", "VM"],
]);

const toPascalCase = (value: string) =>
  value
    .split(/[_-]/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join("");

const expectedNamespaceAlias = (source: string) => {
  const moduleName = source.slice("node:".length);
  const knownAlias = NODE_MODULE_ALIASES.get(moduleName);
  if (knownAlias !== undefined) return `Node${knownAlias}`;

  return `Node${moduleName
    .split("/")
    .map((segment) => NODE_SEGMENT_ALIASES.get(segment) ?? toPascalCase(segment))
    .join("")}`;
};

const literalStringValue = (node: unknown): string | undefined => {
  if (typeof node !== "object" || node === null) return undefined;
  if (!("type" in node) || node.type !== "Literal") return undefined;
  if (!("value" in node) || typeof node.value !== "string") return undefined;
  return node.value;
};

const identifierName = (node: unknown): string | undefined => {
  if (typeof node !== "object" || node === null) return undefined;
  if (!("type" in node) || node.type !== "Identifier") return undefined;
  if (!("name" in node) || typeof node.name !== "string") return undefined;
  return node.name;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require canonical namespace imports for Node.js built-in modules.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = literalStringValue(node.source);
        if (source === undefined || !source.startsWith("node:")) return;

        const expectedAlias = expectedNamespaceAlias(source);
        const namespaceImport =
          node.specifiers.length === 1 && node.specifiers[0]?.type === "ImportNamespaceSpecifier"
            ? node.specifiers[0]
            : undefined;
        const actualAlias = identifierName(namespaceImport?.local);

        if (actualAlias === expectedAlias) return;

        context.report({
          node,
          message: `Import ${source} as a namespace named ${expectedAlias}.`,
        });
      },
    };
  },
});
