// @effect-diagnostics nodeBuiltinImport:off - Knip and the TypeScript compiler host use synchronous Node paths.
import * as NodePath from "node:path";
import type { Preprocessor } from "knip";
import ts from "typescript";

// Effect 4 schemas carry this marker, including aliases and Schema.Class constructors.
// Checking the type avoids evaluating application modules or exempting schema factories/decoders.
const schemaTypeId = "~effect/Schema/Schema";

const preprocess: Preprocessor = (options) => {
  const categories = ["exports", "nsExports", "duplicates"] as const;
  const projects = new Map<string | undefined, Set<string>>();
  for (const category of categories) {
    for (const [filePath, issues] of Object.entries(options.issues[category])) {
      if (Object.keys(issues).length === 0) continue;
      const configPath = ts.findConfigFile(
        NodePath.dirname(NodePath.resolve(options.cwd, filePath)),
        ts.sys.fileExists,
      );
      const files = projects.get(configPath) ?? new Set<string>();
      files.add(filePath);
      projects.set(configPath, files);
    }
  }

  for (const [configPath, files] of projects) {
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
    const program = ts.createProgram(
      [...files].map((file) => NodePath.resolve(options.cwd, file)),
      {
        module: ts.ModuleKind.NodeNext,
        allowJs: true,
        ...config?.options,
        noEmit: true,
      },
    );
    const checker = program.getTypeChecker();
    for (const filePath of files) {
      const source = program.getSourceFile(NodePath.resolve(options.cwd, filePath));
      const module = source && checker.getSymbolAtLocation(source);
      if (!source || !module) continue;
      const schemas = new Set(
        checker.getExportsOfModule(module).flatMap((symbol) => {
          const exported =
            symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          // Duplicate exports can name a private value with a public type of the same name.
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
        }),
      );
      for (const category of categories) {
        const issues = options.issues[category][filePath];
        if (!issues) continue;
        for (const [key, issue] of Object.entries(issues)) {
          const symbols = issue.symbols ?? [{ symbol: issue.symbol }];
          if (symbols.length > 0 && symbols.every(({ symbol }) => schemas.has(symbol))) {
            delete issues[key];
            options.counters[category]--;
          }
        }
        if (Object.keys(issues).length === 0) delete options.issues[category][filePath];
      }
    }
  }
  return options;
};

export default preprocess;
