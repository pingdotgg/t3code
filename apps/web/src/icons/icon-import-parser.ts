import * as ts from "typescript";

const ICON_MODULES = new Set(["lucide-react", "~/icons"]);
const TYPE_ONLY_ICON_EXPORTS = new Set(["LucideIcon", "LucideProps"]);

export function collectRuntimeIconNames(source: string, sourcePath = "fixture.tsx"): string[] {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(sourcePath),
  );
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !ICON_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (importClause?.isTypeOnly === true || !importClause?.namedBindings) continue;
    if (!ts.isNamedImports(importClause.namedBindings)) continue;

    for (const member of importClause.namedBindings.elements) {
      if (member.isTypeOnly) continue;
      const importedName = (member.propertyName ?? member.name).text;
      if (!TYPE_ONLY_ICON_EXPORTS.has(importedName)) names.push(importedName);
    }
  }

  return names;
}

function scriptKindForPath(sourcePath: string): ts.ScriptKind {
  if (sourcePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (sourcePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (sourcePath.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function assertKnownIconNames(
  names: readonly string[],
  knownNames: ReadonlySet<string>,
  sourcePath: string,
): void {
  for (const name of names) {
    if (!knownNames.has(name)) {
      throw new Error(`${sourcePath} imports ${name}, which lucide-react does not export.`);
    }
  }
}
