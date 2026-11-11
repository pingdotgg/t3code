import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ts from "tsrs/unstable/ast";
import { API, TypeFlags, type Type, type Project } from "tsrs/unstable/async";

/**
 * Lints every `Providers.ts` under a workspace package's `src` (alchemy's
 * `src/{Cloud}/Providers.ts` and each provider package's `src/Providers.ts`)
 * and fails if any
 * `providers()` factory ends up with `unknown` or `any` in its Layer requirements
 * (the 3rd `Layer<ROut, E, RIn>` type argument). An `unknown`/`any` RIn means some leaf
 * provider layer leaked an unsatisfied/undeclared requirement, which silently
 * poisons `StackServices` inference across every consumer.
 *
 * For each offending file it reports the specific leaf provider-layer factory
 * call(s) whose requirements include `unknown`.
 */

/** Workspace packages with a `Providers.ts` anywhere under `src`. */
const providerPackages = Effect.fn(function* (packagesRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<string> = [];
  for (const name of yield* fs.readDirectory(packagesRoot)) {
    const src = path.join(packagesRoot, name, "src");
    if (!(yield* fs.exists(src))) continue;
    const files = yield* fs.readDirectory(src, { recursive: true });
    if (files.some((file) => path.basename(file) === "Providers.ts")) {
      found.push(path.join(packagesRoot, name));
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
});

/**
 * Lints one project's `Providers.ts` files, calling `log` per line of output.
 * Resolves to `false` if any `providers()` factory leaks `unknown`/`any`.
 */
async function lintProviders(
  project: Project,
  srcRoot: string,
  relative: (file: string) => string,
  log: (message: string) => void,
): Promise<boolean> {
  const { checker, program } = project;
  const providerPaths = (await program.getSourceFileNames())
    .filter((file) => file.startsWith(`${srcRoot}/`) && file.endsWith("/Providers.ts"))
    .sort((a, b) => a.localeCompare(b));

  // A Layer's requirements are its 3rd type argument: Layer<ROut, E, RIn>.
  async function layerRequirements(type: Type): Promise<Type | undefined> {
    const args = type.isTypeReference() ? await checker.getTypeArguments(type) : [];
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
    const rel = relative(sourceFile.fileName);
    const providersVar = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "providers",
      );
    if (!providersVar) continue;

    // Overall requirements of the `providers()` factory return value.
    const factoryType = await checker.getTypeAtLocation(providersVar);
    const signature = (await factoryType.getCallSignatures())[0];
    const returnType = signature ? await checker.getReturnTypeOfSignature(signature) : undefined;
    const overallReq = returnType ? await layerRequirements(returnType) : undefined;

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
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
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
        (other) => other.node !== node && other.node.pos >= node.pos && other.node.end <= node.end,
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
      log("    (could not localize a leaf culprit — inspect the composite layers)");
    }
    for (const o of offenders) {
      log(`    ✗ ${o.text}  ->  RIn = ${o.req}`);
    }
  }

  return !hadError;
}

const command = Command.make(
  "lint-providers",
  {},
  Effect.fn(function* () {
    const path = yield* Path.Path;
    const cwd = yield* Effect.sync(() => process.cwd());
    const packages = yield* providerPackages(path.resolve(import.meta.dirname, "../packages"));
    const api = yield* Effect.acquireRelease(
      Effect.sync(() => new API()),
      (api) => Effect.promise(() => api.close()),
    );
    const tsConfigs = packages.map((dir) => path.join(dir, "tsconfig.json"));
    const snapshot = yield* Effect.promise(() => api.createSnapshot({ openProjects: tsConfigs }));
    let ok = true;
    for (const dir of packages) {
      const tsConfig = path.join(dir, "tsconfig.json");
      const project = snapshot.getConfiguredProject(tsConfig);
      if (!project) return yield* Effect.die(new Error(`Failed to open ${tsConfig}`));
      const lines: Array<string> = [];
      const passed = yield* Effect.promise(() =>
        lintProviders(
          project,
          path.join(dir, "src"),
          (file) => path.relative(cwd, file),
          (line) => lines.push(line),
        ),
      );
      for (const line of lines) yield* Console.log(line);
      ok = passed && ok;
    }
    if (!ok) {
      return yield* Effect.fail(
        new Error(
          "Provider lint failed: one or more `providers()` factories have `unknown`/`any` requirements.",
        ),
      );
    }
    yield* Console.log("\nAll provider factories have fully-resolved requirements.");
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "Fail if any provider package's `providers()` factory leaks `unknown`/`any` requirements",
  ),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
