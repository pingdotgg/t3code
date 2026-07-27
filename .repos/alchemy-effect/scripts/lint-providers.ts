import * as path from "node:path";

import { Node, Project, type Type } from "ts-morph";

/**
 * Lints every `packages/alchemy/src/{Cloud}/Providers.ts` file and fails if any
 * `providers()` factory ends up with `unknown` in its Layer requirements (the
 * 3rd `Layer<ROut, E, RIn>` type argument). An `unknown` RIn means some leaf
 * provider layer leaked an unsatisfied/undeclared requirement, which silently
 * poisons `StackServices` inference across every consumer.
 *
 * For each offending file it reports the specific leaf provider-layer factory
 * call(s) whose requirements include `unknown`.
 */

const tsConfig = path.join(import.meta.dir, "../packages/alchemy/tsconfig.json");
const srcRoot = path.join(import.meta.dir, "../packages/alchemy/src");

const project = new Project({
  tsConfigFilePath: tsConfig,
  skipAddingFilesFromTsConfig: false,
});

const providerFiles = project
  .getSourceFiles(`${srcRoot}/**/Providers.ts`)
  .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));

// A Layer's requirements are its 3rd type argument: Layer<ROut, E, RIn>.
function layerRequirements(type: Type): Type | undefined {
  const args = type.getTypeArguments();
  if (args.length === 3) return args[2];
  return undefined;
}

function containsUnknown(type: Type): boolean {
  if (type.isUnknown()) return true;
  if (type.isUnion()) return type.getUnionTypes().some(containsUnknown);
  return false;
}

let hadError = false;

for (const sourceFile of providerFiles) {
  const rel = path.relative(process.cwd(), sourceFile.getFilePath());
  const providersVar = sourceFile.getVariableDeclaration("providers");
  if (!providersVar) continue;

  // Overall requirements of the `providers()` factory return value.
  const factoryType = providersVar.getType();
  const returnType = factoryType.getCallSignatures()[0]?.getReturnType();
  const overallReq = returnType ? layerRequirements(returnType) : undefined;

  if (!overallReq || !containsUnknown(overallReq)) {
    console.log(`✓ ${rel}`);
    continue;
  }

  hadError = true;

  // Find the leaf provider-layer factory calls responsible for the leak.
  const offenders = providersVar
    .forEachDescendantAsArray()
    .filter(Node.isCallExpression)
    .flatMap((call) => {
      const text = call.getExpression().getText();
      // Skip the composite Layer wrappers (mergeAll/provide/effect/pipe) and
      // the resource collection — they are `unknown` only because they
      // aggregate the leaves.
      if (/^Layer\.|\.pipe$|collection$/.test(text)) return [];
      if (!/Provider$|providers$|Live$/.test(text)) return [];
      const req = layerRequirements(call.getReturnType());
      return req && containsUnknown(req) ? [{ text, req: req.getText() }] : [];
    });

  console.log(`✗ ${rel}  ->  providers() RIn includes \`unknown\``);
  if (offenders.length === 0) {
    console.log(
      "    (could not localize a leaf culprit — inspect the composite layers)",
    );
  }
  for (const o of offenders) {
    console.log(`    ✗ ${o.text}()  ->  RIn = ${o.req}`);
  }
}

if (hadError) {
  console.error(
    "\nProvider lint failed: one or more `providers()` factories have `unknown` requirements.",
  );
  process.exit(1);
}

console.log("\nAll provider factories have fully-resolved requirements.");
