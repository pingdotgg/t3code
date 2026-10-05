import * as path from "node:path";

import * as ts from "typescript-api/unstable/ast";
import {
  API,
  TypeFlags,
  type Type,
  type Project,
} from "typescript-api/unstable/async";

/**
 * Lints every `packages/alchemy/src/{Cloud}/Providers.ts` file and fails if any
 * `providers()` factory ends up with `unknown` or `any` in its Layer requirements
 * (the 3rd `Layer<ROut, E, RIn>` type argument). An `unknown`/`any` RIn means some leaf
 * provider layer leaked an unsatisfied/undeclared requirement, which silently
 * poisons `StackServices` inference across every consumer.
 *
 * For each offending file it reports the specific leaf provider-layer factory
 * call(s) whose requirements include `unknown`.
 */

const tsConfig = path.join(
  import.meta.dir,
  "../packages/alchemy/tsconfig.json",
);
const srcRoot = path.join(import.meta.dir, "../packages/alchemy/src");

export async function lintProviders(
  project: Project,
  srcRoot: string,
  log: (message: string) => void = console.log,
): Promise<boolean> {
  const { checker, program } = project;
  const providerPaths = (await program.getSourceFileNames())
    .filter(
      (file) =>
        file.startsWith(`${srcRoot}/`) && file.endsWith("/Providers.ts"),
    )
    .sort((a, b) => a.localeCompare(b));

  // A Layer's requirements are its 3rd type argument: Layer<ROut, E, RIn>.
  async function layerRequirements(type: Type): Promise<Type | undefined> {
    const args = type.isTypeReference()
      ? await checker.getTypeArguments(type)
      : [];
    if (args.length === 3) return args[2];
    return undefined;
  }

  // `any` absorbs every other union member, so it must be checked alongside
  // `unknown` or a leaked `any` silently passes.
  async function containsUnknown(type: Type): Promise<boolean> {
    if (type.flags & (TypeFlags.Unknown | TypeFlags.Any)) return true;
    if (type.isUnionType()) {
      for (const member of await type.getTypes()) {
        if (await containsUnknown(member)) return true;
      }
    }
    return false;
  }

  let hadError = false;

  for (const file of providerPaths) {
    const sourceFile = await program.getSourceFile(file);
    if (!sourceFile) throw new Error(`Missing source file ${file}`);
    const rel = path.relative(process.cwd(), sourceFile.fileName);
    const providersVar = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "providers",
      );
    if (!providersVar) continue;

    // Overall requirements of the `providers()` factory return value.
    const factoryType = await checker.getTypeAtLocation(providersVar);
    const signature = (await factoryType.getCallSignatures())[0];
    const returnType = signature
      ? await checker.getReturnTypeOfSignature(signature)
      : undefined;
    const overallReq = returnType
      ? await layerRequirements(returnType)
      : undefined;

    if (!overallReq || !(await containsUnknown(overallReq))) {
      log(`✓ ${rel}`);
      continue;
    }

    hadError = true;

    // Localize the leak structurally: every Layer-typed expression whose RIn
    // is `unknown`/`any`, keeping only the innermost ones (composites such as
    // `Layer.mergeAll(...)` or `.pipe(...)` merely inherit it from a child).
    const candidates: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) ||
        ts.isPropertyAccessExpression(node) ||
        (ts.isIdentifier(node) &&
          !(
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name === node
          ))
      ) {
        candidates.push(node);
      }
      node.forEachChild(visit);
    };
    providersVar.forEachChild(visit);
    const leaking: { node: ts.Node; req: Type }[] = [];
    for (const node of candidates) {
      const type = await checker.getTypeAtLocation(node);
      const req = await layerRequirements(type);
      if (
        req &&
        (await containsUnknown(req)) &&
        (await checker.typeToString(type)).startsWith("Layer<")
      ) {
        leaking.push({ node, req });
      }
    }
    const offenders: { text: string; req: string }[] = [];
    for (const { node, req } of leaking) {
      const hasLeakingChild = leaking.some(
        (other) =>
          other.node !== node &&
          other.node.pos >= node.pos &&
          other.node.end <= node.end,
      );
      if (hasLeakingChild) continue;
      offenders.push({
        text: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120),
        req: await checker.typeToString(req),
      });
    }

    log(
      `✗ ${rel}  ->  providers() RIn includes \`unknown\`/\`any\` (${await checker.typeToString(overallReq)})`,
    );
    if (offenders.length === 0) {
      log(
        "    (could not localize a leaf culprit — inspect the composite layers)",
      );
    }
    for (const o of offenders) {
      log(`    ✗ ${o.text}  ->  RIn = ${o.req}`);
    }
  }

  return !hadError;
}

if (import.meta.main) {
  await using api = new API();
  const snapshot = await api.updateSnapshot({ openProjects: [tsConfig] });
  const project = snapshot.getProject(tsConfig);
  if (!project) throw new Error(`Failed to open ${tsConfig}`);
  if (!(await lintProviders(project, srcRoot))) {
    console.error(
      "\nProvider lint failed: one or more `providers()` factories have `unknown`/`any` requirements.",
    );
    process.exitCode = 1;
  } else {
    console.log("\nAll provider factories have fully-resolved requirements.");
  }
}
