// @effect-diagnostics nodeBuiltinImport:off - Knip and the TypeScript compiler host use synchronous Node paths.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import type { Preprocessor } from "knip";
// Knip needs the legacy compiler API, which TypeScript 7 no longer exports.
import ts from "typescript-legacy";

const schemaTypeId = "~effect/Schema/Schema";

// One tsconfig's files, each with the export names its issues mention. Only
// those names are checked: inferring the type of every export cost seconds.
interface Project {
  readonly cwd: string;
  readonly configPath: string | undefined;
  readonly files: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
}

// Each tsconfig needs its own program. The programs share parsed and bound
// files (Effect's and Node's declarations) through one registry, as the
// language service does. Without it, building 17 programs took about 13 s.
const registry = ts.createDocumentRegistry();

// Returns each file with those of its names that are Effect schemas.
function findSchemas({ cwd, configPath, files }: Project) {
  const config = configPath
    ? ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
          },
        },
      )
    : undefined;
  if (config?.errors.length) {
    throw new Error(
      config.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    allowJs: true,
    ...config?.options,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const key = registry.getKeyForCompilationSettings(options);
  host.getSourceFile = (fileName, languageVersionOrOptions) => {
    const text = host.readFile(fileName);
    if (text === undefined) return undefined;
    return registry.acquireDocumentWithKey(
      fileName,
      ts.sys.resolvePath(fileName) as ts.Path,
      options,
      key,
      ts.ScriptSnapshot.fromString(text),
      // Files do not change during one run.
      "1",
      undefined,
      languageVersionOrOptions,
    );
  };
  const program = ts.createProgram(
    files.map(([file]) => NodePath.resolve(cwd, file)),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  return files.flatMap(([filePath, names]) => {
    const source = program.getSourceFile(NodePath.resolve(cwd, filePath));
    const module = source && checker.getSymbolAtLocation(source);
    if (!source || !module) return [];
    const schemas = checker
      .getExportsOfModule(module)
      .filter((symbol) => names.includes(symbol.name))
      .flatMap((symbol) => {
        const exported =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const target =
          exported.flags & ts.SymbolFlags.Value
            ? exported
            : checker.resolveName(symbol.name, source, ts.SymbolFlags.Value, false);
        if (!target) return [];
        const type = checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration ?? source);
        const marker = type.getProperty(schemaTypeId);
        if (!marker) return [];
        const markerType = checker.getTypeOfSymbolAtLocation(marker, source);
        return markerType.isStringLiteral() && markerType.value === schemaTypeId
          ? [symbol.name]
          : [];
      });
    return [[filePath, schemas] as const];
  });
}

// The preprocessor loads this file again as each worker.
if (!NodeWorkerThreads.isMainThread) {
  const projects: ReadonlyArray<Project> = NodeWorkerThreads.workerData;
  NodeWorkerThreads.parentPort?.postMessage(projects.flatMap(findSchemas));
}

// Three workers measured fastest. Each one parses Effect again, so more
// workers cost more than they save.
const WORKERS = Math.min(3, NodeOS.availableParallelism());

// Drops unused-export issues whose every symbol is an Effect schema.
const preprocess = async (options: Parameters<Preprocessor>[0]) => {
  const categories = ["exports", "nsExports", "duplicates"] as const;
  const projects = new Map<string | undefined, Map<string, Set<string>>>();
  for (const category of categories) {
    for (const [filePath, issues] of Object.entries(options.issues[category])) {
      if (Object.keys(issues).length === 0) continue;
      const configPath = ts.findConfigFile(
        NodePath.dirname(NodePath.resolve(options.cwd, filePath)),
        ts.sys.fileExists,
      );
      const files = projects.get(configPath) ?? new Map<string, Set<string>>();
      const names = files.get(filePath) ?? new Set<string>();
      for (const issue of Object.values(issues)) {
        for (const { symbol } of issue.symbols ?? [{ symbol: issue.symbol }]) names.add(symbol);
      }
      files.set(filePath, names);
      projects.set(configPath, files);
    }
  }

  // Deal the projects out largest first so the workers get similar shares.
  const shares = Array.from({ length: WORKERS }, (): Array<Project> => []);
  [...projects]
    .sort(([, a], [, b]) => b.size - a.size)
    .forEach(([configPath, files], index) => {
      shares[index % WORKERS]!.push({
        cwd: options.cwd,
        configPath,
        files: [...files].map(([file, names]) => [file, [...names]]),
      });
    });
  const workers = shares
    .filter((share) => share.length > 0)
    .map((share) => new NodeWorkerThreads.Worker(new URL(import.meta.url), { workerData: share }));
  const results = await Promise.all(
    workers.map(
      (worker) =>
        new Promise<ReturnType<typeof findSchemas>>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`knip-schemas worker exited with code ${code}`));
          });
        }),
    ),
  ).catch(async (error: unknown) => {
    // knip only sets an exit code on a failed preprocessor, so stop the
    // siblings or the failed run waits for their work.
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    throw error;
  });

  for (const [filePath, names] of results.flat()) {
    for (const category of categories) {
      const issues = options.issues[category][filePath];
      if (!issues) continue;
      for (const [key, issue] of Object.entries(issues)) {
        const symbols = issue.symbols ?? [{ symbol: issue.symbol }];
        if (symbols.length > 0 && symbols.every(({ symbol }) => names.includes(symbol))) {
          delete issues[key];
          options.counters[category]--;
        }
      }
      if (Object.keys(issues).length === 0) delete options.issues[category][filePath];
    }
  }
  return options;
};

export default preprocess;
