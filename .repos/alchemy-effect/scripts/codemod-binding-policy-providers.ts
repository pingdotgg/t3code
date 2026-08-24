import * as path from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";

// Provider directory (relative to packages/alchemy/src) to migrate, e.g. "AWS"
// or "Cloudflare". Defaults to "AWS".
const provider = process.argv[2] ?? "AWS";

const srcRoot = path.join(import.meta.dir, "../packages/alchemy/src", provider);
const providersPath = path.join(srcRoot, "Providers.ts");
const tsConfig = path.join(import.meta.dir, "../packages/alchemy/tsconfig.json");

const project = new Project({
  tsConfigFilePath: tsConfig,
  skipAddingFilesFromTsConfig: true,
});

project.addSourceFilesAtPaths(`${srcRoot}/**/*.ts`);

let filesChanged = 0;
const changed: string[] = [];

for (const sourceFile of project.getSourceFiles()) {
  // Never touch Providers.ts itself.
  if (path.resolve(sourceFile.getFilePath()) === path.resolve(providersPath)) {
    continue;
  }

  let mutated = false;

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== "Policy") continue;
    if (callee.getExpression().getText() !== "Binding") continue;

    const typeArgs = call.getTypeArguments();
    // Only migrate the two-type-argument form; three already has Providers.
    if (typeArgs.length !== 2) continue;

    call.addTypeArgument("Providers");
    mutated = true;
  }

  if (!mutated) continue;

  // Add `import type { Providers } from "<rel>/Providers.ts";` if absent.
  const alreadyImported = sourceFile
    .getImportDeclarations()
    .some((decl) =>
      decl
        .getNamedImports()
        .some((named) => named.getName() === "Providers"),
    );

  if (!alreadyImported) {
    const fromDir = path.dirname(sourceFile.getFilePath());
    let rel = path.relative(fromDir, providersPath).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;

    sourceFile.addImportDeclaration({
      isTypeOnly: true,
      namedImports: ["Providers"],
      moduleSpecifier: rel,
    });
  }

  filesChanged += 1;
  changed.push(path.relative(process.cwd(), sourceFile.getFilePath()));
}

await project.save();

console.log(`Modified ${filesChanged} file(s):`);
for (const file of changed.sort()) {
  console.log(`  ${file}`);
}
