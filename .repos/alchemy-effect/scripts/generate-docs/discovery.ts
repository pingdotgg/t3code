import * as path from "node:path";

import {
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
  type ClassDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

import type { DuplicateGroup, FileKind, SourceEntry } from "./types.ts";
import {
  canonicalScore,
  docOutputPath,
  lowerPathKey,
  srcRoot,
  titleFromRelativePath,
  tsConfigPath,
} from "./utils.ts";

export function createProject() {
  return new Project({
    tsConfigFilePath: tsConfigPath,
    skipFileDependencyResolution: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Double,
    },
  });
}

export function discoverSourceFiles(project: Project) {
  return project
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        sourceFile.getFilePath().startsWith(srcRoot) &&
        !sourceFile.isDeclarationFile(),
    );
}

export function chooseCanonicalEntries(sourceFiles: SourceFile[]) {
  const groups = new Map<string, SourceFile[]>();
  for (const sourceFile of sourceFiles) {
    const relativePath = path.relative(srcRoot, sourceFile.getFilePath());
    const key = lowerPathKey(relativePath);
    const group = groups.get(key);
    if (group) {
      group.push(sourceFile);
    } else {
      groups.set(key, [sourceFile]);
    }
  }

  const entries: SourceEntry[] = [];
  const duplicates: DuplicateGroup[] = [];

  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => {
      const leftRelative = path.relative(srcRoot, left.getFilePath());
      const rightRelative = path.relative(srcRoot, right.getFilePath());
      return (
        canonicalScore(rightRelative) - canonicalScore(leftRelative) ||
        leftRelative.localeCompare(rightRelative)
      );
    });
    const canonical = sorted[0]!;
    const relativePath = path.relative(srcRoot, canonical.getFilePath());
    entries.push({
      relativePath,
      outputPath: docOutputPath(relativePath),
      sourcePath: canonical.getFilePath(),
    });

    if (sorted.length > 1) {
      duplicates.push({
        canonical: relativePath,
        ignored: sorted
          .slice(1)
          .map((file) => path.relative(srcRoot, file.getFilePath())),
      });
    }
  }

  entries.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  duplicates.sort((left, right) =>
    left.canonical.localeCompare(right.canonical),
  );

  return { entries, duplicates };
}

export function sourceFileForEntry(project: Project, entry: SourceEntry) {
  return project.getSourceFileOrThrow(entry.sourcePath);
}

export function getResourceFactory(
  sourceFile: SourceFile,
  factoryName: "Resource" | "Host",
) {
  return sourceFile.getVariableDeclarations().find((declaration) => {
    if (!declaration.isExported()) {
      return false;
    }
    const initializer = declaration.getInitializerIfKind(
      SyntaxKind.CallExpression,
    );
    return initializer?.getExpression().getText() === factoryName;
  });
}

export function getResourceTypeDetails(
  sourceFile: SourceFile,
  factoryName: "Resource" | "Host",
) {
  const declaration = getResourceFactory(sourceFile, factoryName);
  if (!declaration) {
    return undefined;
  }
  const call = declaration.getInitializerIfKindOrThrow(
    SyntaxKind.CallExpression,
  );
  const firstArg = call.getArguments()[0];
  return {
    declaration,
    name: declaration.getName(),
    resourceType:
      firstArg && Node.isStringLiteral(firstArg)
        ? firstArg.getLiteralValue()
        : declaration.getName(),
  };
}

function extendsCall(declaration: ClassDeclaration, expressionText: string) {
  return declaration.getText().includes(`extends ${expressionText}<`);
}

export function getBindingServiceClasses(sourceFile: SourceFile) {
  return sourceFile
    .getClasses()
    .filter(
      (declaration) =>
        declaration.isExported() && extendsCall(declaration, "Binding.Service"),
    );
}

export function getBindingPolicyClasses(sourceFile: SourceFile) {
  return sourceFile
    .getClasses()
    .filter(
      (declaration) =>
        declaration.isExported() && extendsCall(declaration, "Binding.Policy"),
    );
}

export function getExportedNames(sourceFile: SourceFile) {
  return [
    ...sourceFile
      .getClasses()
      .filter((item) => item.isExported())
      .map((item) => item.getName() ?? ""),
    ...sourceFile
      .getFunctions()
      .filter((item) => item.isExported())
      .map((item) => item.getName() ?? ""),
    ...sourceFile
      .getInterfaces()
      .filter((item) => item.isExported())
      .map((item) => item.getName()),
    ...sourceFile
      .getTypeAliases()
      .filter((item) => item.isExported())
      .map((item) => item.getName()),
    ...sourceFile
      .getVariableDeclarations()
      .filter((item) => item.isExported())
      .map((item) => item.getName()),
  ].filter(Boolean);
}

export function getFileKind(sourceFile: SourceFile): FileKind {
  const baseName = sourceFile.getBaseNameWithoutExtension();
  const exportedNames = getExportedNames(sourceFile).join(" ");
  const eventish =
    /EventSource|Sink/.test(baseName) || /EventSource|Sink/.test(exportedNames);

  if (baseName === "index") {
    return "index";
  }
  if (getResourceFactory(sourceFile, "Host")) {
    return "host";
  }
  if (getResourceFactory(sourceFile, "Resource")) {
    return "resource";
  }
  if (
    eventish &&
    (getBindingPolicyClasses(sourceFile).length > 0 ||
      getBindingServiceClasses(sourceFile).length > 0 ||
      sourceFile.getText().includes("Layer.effect("))
  ) {
    return "event-source";
  }
  if (
    getBindingServiceClasses(sourceFile).length > 0 ||
    getBindingPolicyClasses(sourceFile).length > 0
  ) {
    return "operation";
  }
  if (
    baseName === "Providers" ||
    sourceFile
      .getVariableDeclarations()
      .some(
        (declaration) =>
          declaration.isExported() &&
          ["providers", "resources", "bindings"].includes(
            declaration.getName(),
          ),
      )
  ) {
    return "provider";
  }
  return "helper";
}

export function getProviderDeclaration(
  sourceFile: SourceFile,
  name: string,
): VariableDeclaration | undefined {
  return sourceFile.getVariableDeclaration(`${name}Provider`);
}

export function getPrimaryNode(sourceFile: SourceFile, fileKind: FileKind) {
  switch (fileKind) {
    case "resource":
      return getResourceFactory(sourceFile, "Resource")?.getVariableStatement();
    case "host":
      return getResourceFactory(sourceFile, "Host")?.getVariableStatement();
    case "operation":
      return (
        getBindingServiceClasses(sourceFile)[0] ??
        getBindingPolicyClasses(sourceFile)[0]
      );
    case "event-source":
      return (
        sourceFile
          .getVariableDeclarations()
          .find(
            (declaration) =>
              declaration.isExported() &&
              /EventSource|Sink/.test(declaration.getName()),
          )
          ?.getVariableStatement() ?? getBindingPolicyClasses(sourceFile)[0]
      );
    case "provider":
      return sourceFile
        .getVariableDeclarations()
        .find((declaration) => declaration.isExported())
        ?.getVariableStatement();
    case "index":
      return sourceFile.getExportDeclarations()[0];
    default:
      return sourceFile
        .getStatements()
        .find(
          (statement) => Node.isExportable(statement) && statement.isExported(),
        );
  }
}

export function titleForSourceFile(sourceFile: SourceFile) {
  return titleFromRelativePath(
    path.relative(srcRoot, sourceFile.getFilePath()),
  );
}
