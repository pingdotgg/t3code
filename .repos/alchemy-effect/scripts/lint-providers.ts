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
 * `providers()` factory ends up with `unknown` in its Layer requirements (the
 * 3rd `Layer<ROut, E, RIn>` type argument). An `unknown` RIn means some leaf
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

  async function containsUnknown(type: Type): Promise<boolean> {
    if (type.flags & TypeFlags.Unknown) return true;
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

    // Find the leaf provider-layer factory calls responsible for the leak.
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const text = node.expression.getText(sourceFile);
        // Composite wrappers inherit unknown from their leaves.
        if (
          !/^Layer\.|\.pipe$|collection$/.test(text) &&
          /Provider$|providers$|Live$/.test(text)
        ) {
          calls.push(node);
        }
      }
      node.forEachChild(visit);
    };
    providersVar.forEachChild(visit);
    const offenders: { text: string; req: string }[] = [];
    for (const call of calls) {
      const req = await layerRequirements(
        await checker.getTypeAtLocation(call),
      );
      if (req && (await containsUnknown(req))) {
        offenders.push({
          text: call.expression.getText(sourceFile),
          req: await checker.typeToString(req),
        });
      }
    }

    log(`✗ ${rel}  ->  providers() RIn includes \`unknown\``);
    if (offenders.length === 0) {
      log(
        "    (could not localize a leaf culprit — inspect the composite layers)",
      );
    }
    for (const o of offenders) {
      log(`    ✗ ${o.text}()  ->  RIn = ${o.req}`);
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
      "\nProvider lint failed: one or more `providers()` factories have `unknown` requirements.",
    );
    process.exitCode = 1;
  } else {
    console.log("\nAll provider factories have fully-resolved requirements.");
  }
}
