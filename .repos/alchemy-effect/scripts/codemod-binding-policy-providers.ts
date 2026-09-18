import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript-api/unstable/ast";
import { createSyntaxProject } from "./typescript-source.ts";

/** Insert only the missing type argument/import, preserving comments and formatting. */
export function migrateBindingPolicies(
  sourceFile: ts.SourceFile,
  providersPath: string,
): string {
  const filename = sourceFile.fileName;
  let source = sourceFile.text;
  const insertions: { offset: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const callee = node.expression;
      if (
        callee.name.text === "Policy" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Binding" &&
        node.typeArguments?.length === 2
      ) {
        // Keep an existing trailing comma/comment intact.
        insertions.push({
          offset: node.typeArguments[1]!.end,
          text: ", Providers",
        });
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  if (!insertions.length) return source;

  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const alreadyImported = imports.some((node) => {
    const bindings = node.importClause?.namedBindings;
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((specifier) => specifier.name.text === "Providers")
    );
  });
  if (!alreadyImported) {
    let relative = path
      .relative(path.dirname(filename), providersPath)
      .split(path.sep)
      .join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const lastImport = imports.at(-1);
    const offset =
      lastImport?.end ?? (source.startsWith("#!") ? source.indexOf("\n") : 0);
    insertions.push({
      offset,
      text: `${offset ? newline : ""}import type { Providers } from ${JSON.stringify(relative)};${offset ? "" : newline}`,
    });
  }
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    source =
      source.slice(0, insertion.offset) +
      insertion.text +
      source.slice(insertion.offset);
  }
  return source;
}

async function main() {
  const provider = process.argv[2] ?? "AWS";
  const srcRoot = path.join(
    import.meta.dir,
    "../packages/alchemy/src",
    provider,
  );
  const providersPath = path.join(srcRoot, "Providers.ts");
  const changed: string[] = [];
  const files = (await fs.readdir(srcRoot, { recursive: true }))
    .sort()
    .filter((relative) => relative.endsWith(".ts"))
    .map((relative) => path.join(srcRoot, relative))
    .filter((filename) => filename !== providersPath);
  await using syntax = await createSyntaxProject(files);
  for (const filename of files) {
    const sourceFile = await syntax.project.program.getSourceFile(filename);
    if (!sourceFile) throw new Error(`Missing source file ${filename}`);
    const source = sourceFile.text;
    const migrated = migrateBindingPolicies(sourceFile, providersPath);
    if (migrated === source) continue;
    await fs.writeFile(filename, migrated);
    changed.push(path.relative(process.cwd(), filename));
  }
  console.log(`Modified ${changed.length} file(s):`);
  for (const file of changed.sort()) console.log(`  ${file}`);
}

if (import.meta.main) await main();
