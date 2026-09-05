import { parse } from "@babel/parser";

const ignoredAstFields = new Set([
  "start",
  "end",
  "loc",
  "extra",
  "leadingComments",
  "innerComments",
  "trailingComments",
]);

/** Replace identical generated type/schema pairs with aliases in declaration order. */
export function deduplicateGeneratedSchemas(source: string): string {
  const { body } = parse(source, { sourceType: "module", plugins: ["typescript"] }).program;
  const aliases = new Map<string, string>();
  const canonicalNames = new Map<string, string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];

  function normalize(
    value: unknown,
    parent?: Readonly<Record<string, unknown>>,
    field?: string,
    rootIdentifier?: object,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((child: unknown) => normalize(child, undefined, undefined, rootIdentifier));
    }
    if (value === null || typeof value !== "object") return value;
    const node = value as Readonly<Record<string, unknown>>;
    const isPropertyName =
      (field === "property" && !parent?.computed) ||
      (field === "key" && !parent?.computed) ||
      (field === "right" && parent?.type === "TSQualifiedName");
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !ignoredAstFields.has(key))
        .map(([key, child]) => [
          key,
          value === rootIdentifier && key === "value"
            ? "<schema identifier>"
            : node.type === "Identifier" &&
                key === "name" &&
                !isPropertyName &&
                typeof child === "string"
              ? (aliases.get(child) ?? child)
              : normalize(child, node, key, rootIdentifier),
        ]),
    );
  }

  function hasLocalBindings(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasLocalBindings);
    if (value === null || typeof value !== "object") return false;
    const node = value as Readonly<Record<string, unknown>>;
    if (node.type === "VariableDeclaration" || node.type === "FunctionDeclaration") return true;
    if (
      (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
      (node.id != null || (Array.isArray(node.params) && node.params.length > 0))
    ) {
      return true;
    }
    return Object.entries(node).some(
      ([key, child]) => !ignoredAstFields.has(key) && hasLocalBindings(child),
    );
  }

  for (let index = 0; index < body.length - 1; index += 1) {
    const typeExport = body[index];
    const valueExport = body[index + 1];
    if (
      typeExport?.type !== "ExportNamedDeclaration" ||
      typeExport.declaration?.type !== "TSTypeAliasDeclaration" ||
      valueExport?.type !== "ExportNamedDeclaration" ||
      valueExport.declaration?.type !== "VariableDeclaration" ||
      valueExport.declaration.kind !== "const" ||
      valueExport.declaration.declarations.length !== 1
    )
      continue;

    const typeDeclaration = typeExport.declaration;
    const declaration = valueExport.declaration.declarations[0]!;
    const name = typeDeclaration.id.name;
    if (
      declaration.id.type !== "Identifier" ||
      declaration.id.name !== name ||
      !declaration.init ||
      typeDeclaration.typeParameters ||
      hasLocalBindings(declaration.init)
    )
      continue;

    const initializer = declaration.init;
    const annotation =
      initializer.type === "CallExpression" &&
      initializer.callee.type === "MemberExpression" &&
      !initializer.callee.computed &&
      initializer.callee.property.type === "Identifier" &&
      initializer.callee.property.name === "annotate" &&
      initializer.arguments.length === 1 &&
      initializer.arguments[0]?.type === "ObjectExpression"
        ? initializer.arguments[0]
        : undefined;
    const identifierProperty = annotation?.properties.find(
      (property) =>
        property.type === "ObjectProperty" &&
        !property.computed &&
        ((property.key.type === "Identifier" && property.key.name === "identifier") ||
          (property.key.type === "StringLiteral" && property.key.value === "identifier")) &&
        property.value.type === "StringLiteral" &&
        property.value.value === name,
    );
    const rootIdentifier =
      identifierProperty?.type === "ObjectProperty" ? identifierProperty.value : undefined;
    const aliasValue =
      rootIdentifier &&
      annotation?.properties.length === 1 &&
      initializer.type === "CallExpression" &&
      initializer.callee.type === "MemberExpression"
        ? initializer.callee.object
        : initializer;
    if (
      typeDeclaration.typeAnnotation.type === "TSTypeReference" &&
      typeDeclaration.typeAnnotation.typeName.type === "Identifier" &&
      aliasValue.type === "Identifier" &&
      typeDeclaration.typeAnnotation.typeName.name === aliasValue.name
    ) {
      if (!rootIdentifier) {
        aliases.set(name, aliases.get(aliasValue.name) ?? aliasValue.name);
      }
      continue;
    }

    const signature = JSON.stringify([
      rootIdentifier !== undefined,
      normalize(typeDeclaration.typeAnnotation),
      normalize(declaration.id.typeAnnotation),
      normalize(initializer, undefined, undefined, rootIdentifier),
    ]);
    const canonical = canonicalNames.get(signature);
    if (canonical === undefined) {
      canonicalNames.set(signature, name);
      continue;
    }
    // Identifier-bearing aliases retain distinct nested diagnostic labels.
    if (!rootIdentifier) aliases.set(name, canonical);
    edits.push({
      start: typeExport.start!,
      end: valueExport.end!,
      text: `export type ${name} = ${canonical};\nexport const ${name} = ${canonical}${rootIdentifier ? `.annotate({ identifier: ${JSON.stringify(name)} })` : ""};`,
    });
  }

  for (const edit of edits.toReversed()) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}
