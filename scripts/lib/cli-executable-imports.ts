// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import ts from "typescript-legacy";

/** Node single-executable imports resolve only builtins; use createRequire for file-backed external packages. */
export function findEsmImportsOfExternalPackages(source: string): ReadonlyArray<string> {
  const specifiers = new Set<string>();
  const module = ts.createSourceFile(
    "bundle.mjs",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    const dynamic =
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const specifierNode =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : dynamic
          ? node.arguments[0]
          : undefined;
    if (specifierNode && ts.isStringLiteralLike(specifierNode)) {
      const specifier = specifierNode.text;
      // Optional Bun imports are runtime builtins; static Bun imports still fail under Node.
      const runtimeBuiltin =
        NodeModule.isBuiltin(specifier) || (dynamic && specifier.startsWith("bun:"));
      if (!runtimeBuiltin && !specifier.startsWith("./") && !specifier.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return [...specifiers].sort();
}
