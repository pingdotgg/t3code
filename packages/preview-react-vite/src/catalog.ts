import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PreviewCatalogManifest,
  type PreviewCatalogEntry,
  type PreviewPropSummary,
  PreviewScopeManifest,
  type PreviewScopeDirection,
  type PreviewScopeInput,
  type PreviewScopedEntry,
} from "@forma/contracts";
import type { FormaPreviewConfig } from "@forma/preview-react";
import { Schema } from "effect";
import { glob } from "tinyglobby";
import ts from "typescript";

const DEFAULT_PREVIEW_SCAN_INCLUDE = ["src/**/*.preview.tsx"] as const;
const DEFAULT_PREVIEW_SCAN_EXCLUDE = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.stories.*",
  "**/*.story.*",
  "**/node_modules/**",
] as const;
const DEFAULT_COMPONENT_SCAN_INCLUDE = ["src/**/*.{tsx,jsx}"] as const;
const DEFAULT_COMPONENT_SCAN_EXCLUDE = [
  "**/*.preview.*",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.stories.*",
  "**/*.story.*",
  "**/__tests__/**",
  "**/node_modules/**",
] as const;
const DEFAULT_GRAPH_SCAN_INCLUDE = [
  "src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,css,scss,sass,less}",
] as const;
const DEFAULT_GRAPH_SCAN_EXCLUDE = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.stories.*",
  "**/*.story.*",
  "**/__tests__/**",
  "**/node_modules/**",
] as const;
const SCRIPT_GRAPH_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);
const LOCAL_RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".less",
] as const;
const NEGATIVE_VISUAL_PATH_SEGMENTS = new Set([
  "hooks",
  "lib",
  "rpc",
  "store",
  "stores",
  "environments",
  "routes",
  "providers",
  "contexts",
]);
const POSITIVE_VISUAL_PATH_SEGMENTS = new Set([
  "ui",
  "uis",
  "component",
  "components",
  "icon",
  "icons",
]);
const NEGATIVE_VISUAL_EXPORT_SUFFIXES = [
  "Provider",
  "Registry",
  "Store",
  "Context",
  "Boundary",
  "Router",
] as const;

export interface ResolvedPreviewPaths {
  readonly configRoot: string;
  readonly appRoot: string;
  readonly previewInclude: readonly string[];
  readonly previewExclude: readonly string[];
  readonly componentInclude: readonly string[];
  readonly componentExclude: readonly string[];
  readonly graphInclude: readonly string[];
  readonly graphExclude: readonly string[];
}

export interface DiscoveredCatalogEntry extends PreviewCatalogEntry {
  readonly absoluteComponentPath: string;
  readonly absolutePreviewPath?: string | undefined;
}

interface PreviewSourceGraph {
  readonly configRoot: string;
  readonly appRoot: string;
  readonly filePaths: ReadonlySet<string>;
  readonly forwardEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reverseEdges: ReadonlyMap<string, ReadonlySet<string>>;
}

interface PathMappingRule {
  readonly pattern: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly targets: ReadonlyArray<{
    readonly prefix: string;
    readonly suffix: string;
  }>;
}

interface ModuleResolutionConfig {
  readonly compilerOptions: ts.CompilerOptions;
  readonly baseUrl: string | null;
  readonly pathMappings: ReadonlyArray<PathMappingRule>;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function capitalizeSegment(segment: string): string {
  if (segment.length === 0) {
    return segment;
  }
  return `${segment[0]!.toUpperCase()}${segment.slice(1)}`;
}

function formatDisplayLabel(rawValue: string): string {
  return rawValue
    .split(/[-_.\s/]+/g)
    .filter((segment) => segment.length > 0)
    .map(capitalizeSegment)
    .join(" ");
}

function previewComponentPath(previewPath: string): string {
  return previewPath.replace(/\.preview(\.[cm]?[jt]sx?)$/i, "$1");
}

function defaultLabelFromPath(componentPath: string): string {
  return formatDisplayLabel(path.basename(componentPath, path.extname(componentPath)));
}

function createSourceHash(source: string): string {
  return createHash("sha1").update(source).digest("hex");
}

function normalizeAbsolutePath(input: string): string {
  return toPosixPath(path.resolve(input));
}

function relativeFromConfigRoot(configRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(configRoot, absolutePath));
}

function ensureSetValue(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

function addGraphEdge(
  forward: Map<string, Set<string>>,
  reverse: Map<string, Set<string>>,
  from: string,
  to: string,
): void {
  ensureSetValue(forward, from).add(to);
  ensureSetValue(reverse, to).add(from);
}

function pathSegments(pathValue: string): string[] {
  return toPosixPath(pathValue)
    .split("/")
    .filter((segment) => segment.length > 0);
}

function hasAnyHint(hints: ReadonlyArray<string>, values: ReadonlyArray<string>): boolean {
  return values.some((value) => hints.includes(value));
}

function exportNameHasNegativeVisualSuffix(exportName: string): boolean {
  return NEGATIVE_VISUAL_EXPORT_SUFFIXES.some((suffix) => exportName.endsWith(suffix));
}

function createModuleResolutionConfig(appRoot: string): ModuleResolutionConfig {
  const configPath = ts.findConfigFile(appRoot, ts.sys.fileExists);
  if (!configPath) {
    return {
      compilerOptions: {},
      baseUrl: null,
      pathMappings: [],
    };
  }

  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    },
  );
  const compilerOptions = parsed?.options ?? {};
  const baseUrl = compilerOptions.baseUrl
    ? path.resolve(path.dirname(configPath), compilerOptions.baseUrl)
    : null;
  const pathMappings = Object.entries(compilerOptions.paths ?? {}).flatMap(([pattern, targets]) => {
    const starIndex = pattern.indexOf("*");
    const prefix = starIndex >= 0 ? pattern.slice(0, starIndex) : pattern;
    const suffix = starIndex >= 0 ? pattern.slice(starIndex + 1) : "";
    return Array.isArray(targets)
      ? [
          {
            pattern,
            prefix,
            suffix,
            targets: targets.map((target) => {
              const targetStarIndex = target.indexOf("*");
              return {
                prefix: targetStarIndex >= 0 ? target.slice(0, targetStarIndex) : target,
                suffix: targetStarIndex >= 0 ? target.slice(targetStarIndex + 1) : "",
              };
            }),
          } satisfies PathMappingRule,
        ]
      : [];
  });

  return {
    compilerOptions,
    baseUrl,
    pathMappings,
  };
}

function resolveAliasCandidates(
  specifier: string,
  resolutionConfig: ModuleResolutionConfig,
): string[] {
  if (!resolutionConfig.baseUrl) {
    return [];
  }

  const candidates: string[] = [];
  for (const mapping of resolutionConfig.pathMappings) {
    if (!specifier.startsWith(mapping.prefix) || !specifier.endsWith(mapping.suffix)) {
      continue;
    }
    const middle = specifier.slice(mapping.prefix.length, specifier.length - mapping.suffix.length);
    for (const target of mapping.targets) {
      candidates.push(
        path.resolve(resolutionConfig.baseUrl, `${target.prefix}${middle}${target.suffix}`),
      );
    }
  }
  return candidates;
}

function resolveModuleCandidates(
  specifier: string,
  containingFile: string,
  resolutionConfig: ModuleResolutionConfig,
): string[] {
  if (specifier.startsWith(".")) {
    return [path.resolve(path.dirname(containingFile), specifier)];
  }
  if (specifier.startsWith("/")) {
    return [path.resolve(specifier)];
  }
  return resolveAliasCandidates(specifier, resolutionConfig);
}

function resolveCandidateToFile(candidate: string, filePaths: ReadonlySet<string>): string | null {
  const normalizedCandidate = normalizeAbsolutePath(candidate);
  if (filePaths.has(normalizedCandidate)) {
    return normalizedCandidate;
  }

  if (path.extname(normalizedCandidate).length > 0) {
    return null;
  }

  for (const extension of LOCAL_RESOLUTION_EXTENSIONS) {
    const withExtension = `${normalizedCandidate}${extension}`;
    if (filePaths.has(withExtension)) {
      return withExtension;
    }
  }

  for (const extension of LOCAL_RESOLUTION_EXTENSIONS) {
    const indexPath = normalizeAbsolutePath(path.join(normalizedCandidate, `index${extension}`));
    if (filePaths.has(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

function resolveLocalModulePath(input: {
  readonly specifier: string;
  readonly containingFile: string;
  readonly filePaths: ReadonlySet<string>;
  readonly resolutionConfig: ModuleResolutionConfig;
}): string | null {
  const tsResolution = ts.resolveModuleName(
    input.specifier,
    input.containingFile,
    input.resolutionConfig.compilerOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (tsResolution) {
    const normalizedTsResolution = normalizeAbsolutePath(tsResolution);
    if (input.filePaths.has(normalizedTsResolution)) {
      return normalizedTsResolution;
    }
  }

  for (const candidate of resolveModuleCandidates(
    input.specifier,
    input.containingFile,
    input.resolutionConfig,
  )) {
    const resolvedFile = resolveCandidateToFile(candidate, input.filePaths);
    if (resolvedFile) {
      return resolvedFile;
    }
  }

  return null;
}

function importSpecifiersFromSourceFile(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  return specifiers;
}

function isComponentName(name: string): boolean {
  const first = name[0];
  return !!first && first.toUpperCase() === first && first.toLowerCase() !== first;
}

function hasExportModifier(node: ts.Node): boolean {
  return !!ts
    .getModifiers(node as ts.HasModifiers)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.Node): boolean {
  return !!ts
    .getModifiers(node as ts.HasModifiers)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function isIdentifierName(node: ts.Node | undefined): node is ts.Identifier {
  return !!node && ts.isIdentifier(node);
}

function extractFunctionLikeFromInitializer(
  initializer: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!initializer) {
    return null;
  }
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (ts.isCallExpression(initializer)) {
    for (const argument of initializer.arguments) {
      const functionLike = extractFunctionLikeFromInitializer(argument);
      if (functionLike) {
        return functionLike;
      }
    }
  }
  return null;
}

function extractPropsTypeFromComponentType(typeNode: ts.TypeNode | undefined): ts.TypeNode | null {
  if (!typeNode) {
    return null;
  }
  if (
    ts.isTypeReferenceNode(typeNode) &&
    typeNode.typeArguments?.length &&
    ts.isQualifiedName(typeNode.typeName) &&
    typeNode.typeName.right.text === "FC"
  ) {
    return typeNode.typeArguments[0] ?? null;
  }
  if (
    ts.isTypeReferenceNode(typeNode) &&
    typeNode.typeArguments?.length &&
    ts.isIdentifier(typeNode.typeName) &&
    (typeNode.typeName.text === "FC" || typeNode.typeName.text === "FunctionComponent")
  ) {
    return typeNode.typeArguments[0] ?? null;
  }
  return null;
}

function extractPropsTypeNode(input: {
  readonly declarationType: ts.TypeNode | undefined;
  readonly parameterType: ts.TypeNode | undefined;
}): ts.TypeNode | null {
  return (
    extractPropsTypeFromComponentType(input.declarationType) ??
    input.parameterType ??
    extractPropsTypeFromComponentType(input.parameterType) ??
    null
  );
}

function collectLocalTypeDeclarations(sourceFile: ts.SourceFile) {
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const aliases = new Map<string, ts.TypeAliasDeclaration>();

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name) {
      interfaces.set(statement.name.text, statement);
    } else if (ts.isTypeAliasDeclaration(statement) && statement.name) {
      aliases.set(statement.name.text, statement);
    }
  }

  return { interfaces, aliases };
}

type CvaVariantOptionsByProp = Record<string, string[]>;

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function extractObjectLiteralProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | null {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (propertyNameText(property.name) === propertyName) {
      return property.initializer;
    }
  }
  return null;
}

function collectLocalCvaDeclarations(
  sourceFile: ts.SourceFile,
): Map<string, CvaVariantOptionsByProp> {
  const declarations = new Map<string, CvaVariantOptionsByProp>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifierName(declaration.name) || !declaration.initializer) {
        continue;
      }
      if (!ts.isCallExpression(declaration.initializer)) {
        continue;
      }
      if (!ts.isIdentifier(declaration.initializer.expression)) {
        continue;
      }
      if (declaration.initializer.expression.text !== "cva") {
        continue;
      }

      const configArgument = declaration.initializer.arguments[1];
      if (!configArgument || !ts.isObjectLiteralExpression(configArgument)) {
        continue;
      }
      const variantsExpression = extractObjectLiteralProperty(configArgument, "variants");
      if (!variantsExpression || !ts.isObjectLiteralExpression(variantsExpression)) {
        continue;
      }

      const variantsByProp: CvaVariantOptionsByProp = {};
      for (const property of variantsExpression.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const variantName = propertyNameText(property.name);
        if (!variantName || !ts.isObjectLiteralExpression(property.initializer)) {
          continue;
        }
        const optionNames = property.initializer.properties.flatMap((optionProperty) => {
          if (!ts.isPropertyAssignment(optionProperty)) {
            return [];
          }
          const optionName = propertyNameText(optionProperty.name);
          return optionName ? [optionName] : [];
        });
        if (optionNames.length > 0) {
          variantsByProp[variantName] = optionNames;
        }
      }

      if (Object.keys(variantsByProp).length > 0) {
        declarations.set(declaration.name.text, variantsByProp);
      }
    }
  }

  return declarations;
}

function summarizeIndexedAccessKind(
  typeNode: ts.IndexedAccessTypeNode,
  cvaDeclarations: ReadonlyMap<string, CvaVariantOptionsByProp>,
): Omit<PreviewPropSummary, "name" | "label" | "required"> | null {
  if (
    !ts.isLiteralTypeNode(typeNode.indexType) ||
    !ts.isStringLiteral(typeNode.indexType.literal)
  ) {
    return null;
  }
  if (!ts.isTypeReferenceNode(typeNode.objectType)) {
    return null;
  }
  if (!ts.isIdentifier(typeNode.objectType.typeName)) {
    return null;
  }
  if (typeNode.objectType.typeName.text !== "VariantProps") {
    return null;
  }
  const targetType = typeNode.objectType.typeArguments?.[0];
  if (!targetType || !ts.isTypeQueryNode(targetType) || !ts.isIdentifier(targetType.exprName)) {
    return null;
  }

  const variantName = typeNode.indexType.literal.text;
  const options = cvaDeclarations.get(targetType.exprName.text)?.[variantName];
  if (!options || options.length === 0) {
    return null;
  }

  return {
    kind: "enum",
    options,
  };
}

function summarizePropertyKind(
  typeNode: ts.TypeNode | undefined,
  name: string,
  cvaDeclarations: ReadonlyMap<string, CvaVariantOptionsByProp>,
): Omit<PreviewPropSummary, "name" | "label" | "required"> {
  if (!typeNode) {
    return { kind: "unknown" };
  }
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return { kind: "boolean" };
  }
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
    return { kind: "number" };
  }
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    return { kind: name === "children" ? "children" : "text" };
  }
  if (ts.isFunctionTypeNode(typeNode)) {
    return { kind: "callback" };
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const stringOptions = typeNode.types.flatMap((member) =>
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
        ? [member.literal.text]
        : [],
    );
    if (stringOptions.length > 0 && stringOptions.length === typeNode.types.length) {
      return {
        kind: "enum",
        options: stringOptions,
      };
    }
    if (typeNode.types.some((member) => member.kind === ts.SyntaxKind.BooleanKeyword)) {
      return { kind: "boolean" };
    }
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : null;
    if (name === "children" || typeName === "ReactNode" || typeName === "PropsWithChildren") {
      return { kind: "children" };
    }
  }
  if (ts.isIndexedAccessTypeNode(typeNode)) {
    return summarizeIndexedAccessKind(typeNode, cvaDeclarations) ?? { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function resolvePropSummaries(
  typeNode: ts.TypeNode | null,
  declarations: ReturnType<typeof collectLocalTypeDeclarations>,
  cvaDeclarations: ReadonlyMap<string, CvaVariantOptionsByProp>,
  seen = new Set<string>(),
): PreviewPropSummary[] {
  if (!typeNode) {
    return [];
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return resolvePropSummaries(typeNode.type, declarations, cvaDeclarations, seen);
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap((member) =>
      resolvePropSummaries(member, declarations, cvaDeclarations, seen),
    );
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || !isIdentifierName(member.name)) {
        return [];
      }
      const name = member.name.text;
      if (seen.has(name)) {
        return [];
      }
      seen.add(name);
      return [
        {
          name,
          label: formatDisplayLabel(name),
          ...summarizePropertyKind(member.type, name, cvaDeclarations),
          required: !member.questionToken,
        } satisfies PreviewPropSummary,
      ];
    });
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text;
    const interfaceDeclaration = declarations.interfaces.get(typeName);
    if (interfaceDeclaration) {
      const inherited = interfaceDeclaration.heritageClauses?.flatMap((clause) =>
        clause.types.flatMap((heritageType) =>
          resolvePropSummaries(heritageType, declarations, cvaDeclarations, seen),
        ),
      );
      const local = interfaceDeclaration.members.flatMap((member) => {
        if (!ts.isPropertySignature(member) || !isIdentifierName(member.name)) {
          return [];
        }
        const name = member.name.text;
        if (seen.has(name)) {
          return [];
        }
        seen.add(name);
        return [
          {
            name,
            label: formatDisplayLabel(name),
            ...summarizePropertyKind(member.type, name, cvaDeclarations),
            required: !member.questionToken,
          } satisfies PreviewPropSummary,
        ];
      });
      return [...(inherited ?? []), ...local];
    }
    const aliasDeclaration = declarations.aliases.get(typeName);
    if (aliasDeclaration) {
      return resolvePropSummaries(aliasDeclaration.type, declarations, cvaDeclarations, seen);
    }
  }
  return [];
}

interface ComponentDeclaration {
  readonly localName: string;
  readonly label: string;
  readonly propsTypeNode: ts.TypeNode | null;
}

function collectComponentDeclarations(
  sourceFile: ts.SourceFile,
): Map<string, ComponentDeclaration> {
  const declarations = new Map<string, ComponentDeclaration>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      if (!isComponentName(name)) {
        continue;
      }
      declarations.set(name, {
        localName: name,
        label: formatDisplayLabel(name),
        propsTypeNode: extractPropsTypeNode({
          declarationType: undefined,
          parameterType: statement.parameters[0]?.type,
        }),
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifierName(declaration.name)) {
          continue;
        }
        const name = declaration.name.text;
        if (!isComponentName(name)) {
          continue;
        }
        const functionLike = extractFunctionLikeFromInitializer(declaration.initializer);
        declarations.set(name, {
          localName: name,
          label: formatDisplayLabel(name),
          propsTypeNode: extractPropsTypeNode({
            declarationType: declaration.type,
            parameterType: functionLike?.parameters[0]?.type,
          }),
        });
      }
    }
  }

  return declarations;
}

function exportedComponentNames(
  sourceFile: ts.SourceFile,
  declarations: Map<string, ComponentDeclaration>,
  absoluteComponentPath: string,
): Array<{ readonly localName: string; readonly exportName: string; readonly label: string }> {
  const exported = new Map<string, { localName: string; exportName: string; label: string }>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      const name = statement.name.text;
      if (!declarations.has(name)) {
        continue;
      }
      exported.set(name, {
        localName: name,
        exportName: hasDefaultModifier(statement) ? "default" : name,
        label: hasDefaultModifier(statement)
          ? defaultLabelFromPath(absoluteComponentPath)
          : formatDisplayLabel(name),
      });
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifierName(declaration.name)) {
          continue;
        }
        const name = declaration.name.text;
        if (!declarations.has(name)) {
          continue;
        }
        exported.set(name, {
          localName: name,
          exportName: hasDefaultModifier(statement) ? "default" : name,
          label: hasDefaultModifier(statement)
            ? defaultLabelFromPath(absoluteComponentPath)
            : formatDisplayLabel(name),
        });
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const localName = statement.expression.text;
      if (!declarations.has(localName)) {
        continue;
      }
      exported.set(localName, {
        localName,
        exportName: "default",
        label: defaultLabelFromPath(absoluteComponentPath),
      });
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (!ts.isNamedExports(statement.exportClause) || statement.moduleSpecifier) {
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        if (!declarations.has(localName)) {
          continue;
        }
        exported.set(`${localName}:${element.name.text}`, {
          localName,
          exportName: element.name.text,
          label: formatDisplayLabel(element.name.text),
        });
      }
    }
  }

  return [...exported.values()];
}

function componentIdFor(componentPath: string, exportName: string): string {
  return `${componentPath}#${exportName}`;
}

function sourceFileHasJsxSignal(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      found = true;
      return;
    }
    if (!found) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function usageHintsForComponent(input: {
  readonly componentPath: string;
  readonly exportName: string;
  readonly propSummary: ReadonlyArray<PreviewPropSummary>;
  readonly sourceFile: ts.SourceFile;
}): string[] {
  const hints = new Set<string>();
  const segments = pathSegments(input.componentPath).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => POSITIVE_VISUAL_PATH_SEGMENTS.has(segment))) {
    hints.add("ui-path");
  }
  if (segments.some((segment) => NEGATIVE_VISUAL_PATH_SEGMENTS.has(segment))) {
    hints.add("infrastructure-path");
  }
  if (input.propSummary.some((prop) => prop.name === "variant")) {
    hints.add("has-variant-prop");
  }
  if (input.propSummary.some((prop) => prop.name === "size")) {
    hints.add("has-size-prop");
  }
  if (input.propSummary.some((prop) => prop.name === "children")) {
    hints.add("has-children-prop");
  }
  if (input.propSummary.some((prop) => prop.name === "className")) {
    hints.add("has-classname-prop");
  }
  if (sourceFileHasJsxSignal(input.sourceFile)) {
    hints.add("jsx-render");
  }
  if (input.exportName.toLowerCase().includes("icon")) {
    hints.add("icon-export");
  }
  if (exportNameHasNegativeVisualSuffix(input.exportName)) {
    hints.add("low-signal-export");
  }
  return [...hints];
}

function isVisualScopedEntry(
  entry: Pick<
    PreviewScopedEntry,
    "kind" | "componentPath" | "exportName" | "propSummary" | "usageHints"
  >,
): boolean {
  if (entry.kind === "legacy") {
    return true;
  }

  const hasPositiveSignal =
    hasAnyHint(entry.usageHints, [
      "jsx-render",
      "ui-path",
      "icon-export",
      "has-variant-prop",
      "has-size-prop",
      "has-children-prop",
      "has-classname-prop",
    ]) ||
    pathSegments(entry.componentPath).some((segment) =>
      POSITIVE_VISUAL_PATH_SEGMENTS.has(segment.toLowerCase()),
    );

  const hasNegativeSignal =
    hasAnyHint(entry.usageHints, ["infrastructure-path", "low-signal-export"]) ||
    pathSegments(entry.componentPath).some((segment) =>
      NEGATIVE_VISUAL_PATH_SEGMENTS.has(segment.toLowerCase()),
    ) ||
    exportNameHasNegativeVisualSuffix(entry.exportName);

  return hasPositiveSignal || !hasNegativeSignal;
}

export function resolvePreviewPaths(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): ResolvedPreviewPaths {
  const configRoot = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();
  return {
    configRoot,
    appRoot: path.resolve(configRoot, previewConfig.appRoot),
    previewInclude: previewConfig.scan?.include ?? DEFAULT_PREVIEW_SCAN_INCLUDE,
    previewExclude: previewConfig.scan?.exclude ?? DEFAULT_PREVIEW_SCAN_EXCLUDE,
    componentInclude: previewConfig.components?.include ?? DEFAULT_COMPONENT_SCAN_INCLUDE,
    componentExclude: previewConfig.components?.exclude ?? DEFAULT_COMPONENT_SCAN_EXCLUDE,
    graphInclude: previewConfig.graph?.include ?? DEFAULT_GRAPH_SCAN_INCLUDE,
    graphExclude: previewConfig.graph?.exclude ?? DEFAULT_GRAPH_SCAN_EXCLUDE,
  };
}

async function scanComponentEntriesForFiles(
  absoluteFiles: ReadonlyArray<string>,
  configRoot: string,
): Promise<DiscoveredCatalogEntry[]> {
  const entries: DiscoveredCatalogEntry[] = [];

  for (const file of absoluteFiles) {
    const absoluteComponentPath = path.resolve(file);
    const source = await readFile(absoluteComponentPath, "utf8");
    const sourceFile = ts.createSourceFile(
      absoluteComponentPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      absoluteComponentPath.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX,
    );
    const declarations = collectComponentDeclarations(sourceFile);
    if (declarations.size === 0) {
      continue;
    }
    const localTypes = collectLocalTypeDeclarations(sourceFile);
    const localCvaDeclarations = collectLocalCvaDeclarations(sourceFile);
    const relativeComponentPath = toPosixPath(path.relative(configRoot, absoluteComponentPath));
    const sourceHash = createSourceHash(source);

    for (const exportedName of exportedComponentNames(
      sourceFile,
      declarations,
      absoluteComponentPath,
    )) {
      const declaration = declarations.get(exportedName.localName);
      if (!declaration) {
        continue;
      }
      const propSummary = resolvePropSummaries(
        declaration.propsTypeNode,
        localTypes,
        localCvaDeclarations,
      );
      entries.push({
        id: componentIdFor(relativeComponentPath, exportedName.exportName),
        label: exportedName.label,
        componentPath: relativeComponentPath,
        exportName: exportedName.exportName,
        kind: "component",
        propSummary,
        sourceHash,
        usageHints: usageHintsForComponent({
          componentPath: relativeComponentPath,
          exportName: exportedName.exportName,
          propSummary,
          sourceFile,
        }),
        supported: true,
        absoluteComponentPath,
      });
    }
  }

  return entries.toSorted((left, right) => left.label.localeCompare(right.label));
}

async function scanComponentEntries(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): Promise<DiscoveredCatalogEntry[]> {
  const { appRoot, componentExclude, componentInclude, configRoot } = resolvePreviewPaths(
    previewConfig,
    configPath,
  );
  const files = await glob(componentInclude, {
    cwd: appRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [...componentExclude],
  });
  return scanComponentEntriesForFiles(files, configRoot);
}

async function scanLegacyEntries(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): Promise<DiscoveredCatalogEntry[]> {
  const { previewExclude, previewInclude, appRoot, configRoot } = resolvePreviewPaths(
    previewConfig,
    configPath,
  );
  const files = await glob(previewInclude, {
    cwd: appRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [...previewExclude],
  });
  const entries: DiscoveredCatalogEntry[] = [];

  for (const file of files) {
    const absolutePreviewPath = path.resolve(file);
    const relativePreviewPath = toPosixPath(path.relative(configRoot, absolutePreviewPath));
    const relativeComponentPath = toPosixPath(
      path.relative(configRoot, previewComponentPath(absolutePreviewPath)),
    );
    const sourceHash = createSourceHash(await readFile(absolutePreviewPath, "utf8"));
    entries.push({
      id: `legacy:${relativePreviewPath}`,
      label: defaultLabelFromPath(relativeComponentPath),
      componentPath: relativeComponentPath,
      exportName: "default",
      kind: "legacy",
      propSummary: [],
      sourceHash,
      usageHints: ["legacy-preview", "jsx-render"],
      supported: true,
      legacyPreviewPath: relativePreviewPath,
      absoluteComponentPath: path.resolve(configRoot, relativeComponentPath),
      absolutePreviewPath,
    });
  }

  return entries.toSorted((left, right) => left.label.localeCompare(right.label));
}

export async function buildPreviewSourceGraph(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): Promise<PreviewSourceGraph> {
  const { appRoot, configRoot, graphExclude, graphInclude } = resolvePreviewPaths(
    previewConfig,
    configPath,
  );
  const files = await glob(graphInclude, {
    cwd: appRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [...graphExclude],
  });
  const normalizedFiles = files.map((file) => normalizeAbsolutePath(file));
  const filePaths = new Set(normalizedFiles);
  const forwardEdges = new Map<string, Set<string>>();
  const reverseEdges = new Map<string, Set<string>>();
  const resolutionConfig = createModuleResolutionConfig(appRoot);

  await Promise.all(
    normalizedFiles.map(async (absoluteFilePath) => {
      ensureSetValue(forwardEdges, relativeFromConfigRoot(configRoot, absoluteFilePath));
      ensureSetValue(reverseEdges, relativeFromConfigRoot(configRoot, absoluteFilePath));

      if (!SCRIPT_GRAPH_EXTENSIONS.has(path.extname(absoluteFilePath))) {
        return;
      }

      const source = await readFile(absoluteFilePath, "utf8");
      const scriptKind =
        absoluteFilePath.endsWith(".jsx") || absoluteFilePath.endsWith(".js")
          ? ts.ScriptKind.JSX
          : ts.ScriptKind.TSX;
      const sourceFile = ts.createSourceFile(
        absoluteFilePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );

      const fromPath = relativeFromConfigRoot(configRoot, absoluteFilePath);
      for (const specifier of importSpecifiersFromSourceFile(sourceFile)) {
        const resolved = resolveLocalModulePath({
          specifier,
          containingFile: absoluteFilePath,
          filePaths,
          resolutionConfig,
        });
        if (!resolved) {
          continue;
        }
        const toPath = relativeFromConfigRoot(configRoot, resolved);
        addGraphEdge(forwardEdges, reverseEdges, fromPath, toPath);
      }
    }),
  );

  return {
    configRoot,
    appRoot,
    filePaths,
    forwardEdges,
    reverseEdges,
  };
}

function normalizeScopedChangedFile(input: {
  readonly configRoot: string;
  readonly workspaceRoot: string;
  readonly changedFile: string;
}): string | null {
  const trimmedChangedFile = input.changedFile.trim();
  if (trimmedChangedFile.length === 0) {
    return null;
  }

  const normalizedChangedFile = toPosixPath(trimmedChangedFile);
  const configRoot = normalizeAbsolutePath(input.configRoot);
  const workspaceRoot = normalizeAbsolutePath(input.workspaceRoot);

  if (path.isAbsolute(trimmedChangedFile)) {
    const absoluteChangedFile = normalizeAbsolutePath(trimmedChangedFile);
    if (absoluteChangedFile === configRoot || absoluteChangedFile.startsWith(`${configRoot}/`)) {
      return relativeFromConfigRoot(configRoot, absoluteChangedFile);
    }
    if (
      absoluteChangedFile === workspaceRoot ||
      absoluteChangedFile.startsWith(`${workspaceRoot}/`)
    ) {
      return relativeFromConfigRoot(configRoot, absoluteChangedFile);
    }
    return normalizedChangedFile;
  }

  const fromConfigRoot = normalizeAbsolutePath(path.resolve(configRoot, trimmedChangedFile));
  if (fromConfigRoot === configRoot || fromConfigRoot.startsWith(`${configRoot}/`)) {
    return relativeFromConfigRoot(configRoot, fromConfigRoot);
  }

  const fromWorkspaceRoot = normalizeAbsolutePath(path.resolve(workspaceRoot, trimmedChangedFile));
  if (fromWorkspaceRoot === configRoot || fromWorkspaceRoot.startsWith(`${configRoot}/`)) {
    return relativeFromConfigRoot(configRoot, fromWorkspaceRoot);
  }

  return normalizedChangedFile;
}

function scopedRelationshipForLegacyEntry(input: {
  readonly entry: DiscoveredCatalogEntry;
  readonly relationshipsByPath: ReadonlyMap<
    string,
    { relationship: PreviewScopedEntry["relationship"]; distance: number }
  >;
}): { relationship: PreviewScopedEntry["relationship"]; distance: number } | null {
  const legacyRelationship = input.entry.legacyPreviewPath
    ? input.relationshipsByPath.get(input.entry.legacyPreviewPath)
    : null;
  if (legacyRelationship) {
    return {
      relationship: "legacy",
      distance: legacyRelationship.distance,
    };
  }

  const componentRelationship = input.relationshipsByPath.get(input.entry.componentPath);
  if (!componentRelationship) {
    return null;
  }

  return {
    relationship:
      componentRelationship.relationship === "changed"
        ? "same-file"
        : componentRelationship.relationship,
    distance: componentRelationship.distance,
  };
}

function nextScopedRelationship(
  current: { relationship: PreviewScopedEntry["relationship"]; distance: number } | undefined,
  next: { relationship: PreviewScopedEntry["relationship"]; distance: number },
): { relationship: PreviewScopedEntry["relationship"]; distance: number } {
  if (!current) {
    return next;
  }
  if (next.distance < current.distance) {
    return next;
  }
  if (next.distance === current.distance && next.relationship === "changed") {
    return next;
  }
  return current;
}

function expandScopedRelationships(input: {
  readonly graph: PreviewSourceGraph;
  readonly changedFiles: ReadonlyArray<string>;
  readonly direction: PreviewScopeDirection;
  readonly hopCount: number;
}): Map<string, { relationship: PreviewScopedEntry["relationship"]; distance: number }> {
  const relationships = new Map<
    string,
    { relationship: PreviewScopedEntry["relationship"]; distance: number }
  >();
  const queue: Array<{
    path: string;
    relationship: PreviewScopedEntry["relationship"];
    distance: number;
  }> = input.changedFiles.map((changedFile) => ({
    path: changedFile,
    relationship: "changed" as const,
    distance: 0,
  }));

  for (const item of queue) {
    relationships.set(
      item.path,
      nextScopedRelationship(relationships.get(item.path), {
        relationship: item.relationship,
        distance: item.distance,
      }),
    );
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current.distance >= input.hopCount) {
      continue;
    }

    if (input.direction === "forward" || input.direction === "both") {
      for (const target of input.graph.forwardEdges.get(current.path) ?? []) {
        const next = { relationship: "import" as const, distance: current.distance + 1 };
        const previous = relationships.get(target);
        const resolved = nextScopedRelationship(previous, next);
        if (previous !== resolved) {
          relationships.set(target, resolved);
          queue.push({ path: target, ...resolved });
        }
      }
    }

    if (input.direction === "reverse" || input.direction === "both") {
      for (const target of input.graph.reverseEdges.get(current.path) ?? []) {
        const next = { relationship: "importer" as const, distance: current.distance + 1 };
        const previous = relationships.get(target);
        const resolved = nextScopedRelationship(previous, next);
        if (previous !== resolved) {
          relationships.set(target, resolved);
          queue.push({ path: target, ...resolved });
        }
      }
    }
  }

  return relationships;
}

export async function buildScopedPreviewEntries(input: {
  readonly previewConfig: FormaPreviewConfig;
  readonly configPath: string | undefined;
  readonly workspaceRoot: string;
  readonly scope: PreviewScopeInput;
  readonly graph: PreviewSourceGraph;
}): Promise<{
  readonly manifest: PreviewScopeManifest;
  readonly entries: readonly DiscoveredCatalogEntry[];
}> {
  const { componentExclude, componentInclude, configRoot, appRoot } = resolvePreviewPaths(
    input.previewConfig,
    input.configPath,
  );
  const allComponentFiles = await glob(componentInclude, {
    cwd: appRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [...componentExclude],
  });
  const componentFileSet = new Set(
    allComponentFiles.map((absolutePath) => relativeFromConfigRoot(configRoot, absolutePath)),
  );
  const normalizedChangedFiles = [
    ...new Set(
      input.scope.changedFiles
        .map((changedFile) =>
          normalizeScopedChangedFile({
            configRoot,
            workspaceRoot: input.workspaceRoot,
            changedFile,
          }),
        )
        .filter((value): value is string => value !== null),
    ),
  ];
  const relationshipsByPath = expandScopedRelationships({
    graph: input.graph,
    changedFiles: normalizedChangedFiles,
    direction: input.scope.direction,
    hopCount: input.scope.hopCount,
  });

  const candidateComponentPaths = [...relationshipsByPath.keys()].filter((candidatePath) =>
    componentFileSet.has(candidatePath),
  );
  const componentEntries = await scanComponentEntriesForFiles(
    candidateComponentPaths.map((relativePath) => path.resolve(configRoot, relativePath)),
    configRoot,
  );
  const legacyEntries = await scanLegacyEntries(input.previewConfig, input.configPath);

  const scopedEntries: PreviewScopedEntry[] = [];
  const discoveredEntries: DiscoveredCatalogEntry[] = [];

  for (const componentEntry of componentEntries) {
    const relationship = relationshipsByPath.get(componentEntry.componentPath);
    if (!relationship) {
      continue;
    }
    const scopedEntry: PreviewScopedEntry = {
      ...componentEntry,
      relationship: relationship.relationship,
      distance: relationship.distance,
    };
    if (input.scope.visualOnly && !isVisualScopedEntry(scopedEntry)) {
      continue;
    }
    scopedEntries.push(scopedEntry);
    discoveredEntries.push(componentEntry);
  }

  for (const legacyEntry of legacyEntries) {
    const relationship = scopedRelationshipForLegacyEntry({
      entry: legacyEntry,
      relationshipsByPath,
    });
    if (!relationship) {
      continue;
    }
    const scopedEntry: PreviewScopedEntry = {
      ...legacyEntry,
      relationship: relationship.relationship,
      distance: relationship.distance,
    };
    scopedEntries.push(scopedEntry);
    discoveredEntries.push(legacyEntry);
  }

  const sortedEntries = scopedEntries.toSorted((left, right) => {
    if (left.distance !== right.distance) {
      return left.distance - right.distance;
    }
    return left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });

  return {
    manifest: Schema.decodeUnknownSync(PreviewScopeManifest)({
      generatedAt: new Date().toISOString(),
      appRoot: toPosixPath(path.relative(configRoot, appRoot)),
      entries: sortedEntries,
    }),
    entries: discoveredEntries.toSorted((left, right) => left.label.localeCompare(right.label)),
  };
}

export async function buildPreviewCatalog(
  previewConfig: FormaPreviewConfig,
  configPath: string | undefined,
): Promise<{
  readonly manifest: PreviewCatalogManifest;
  readonly entries: readonly DiscoveredCatalogEntry[];
}> {
  const componentEntries = await scanComponentEntries(previewConfig, configPath);
  const legacyEntries = await scanLegacyEntries(previewConfig, configPath);
  const entries = [...componentEntries, ...legacyEntries].toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
  const { appRoot, configRoot } = resolvePreviewPaths(previewConfig, configPath);

  return {
    manifest: Schema.decodeUnknownSync(PreviewCatalogManifest)({
      generatedAt: new Date().toISOString(),
      appRoot: toPosixPath(path.relative(configRoot, appRoot)),
      entries: entries.map(
        ({ absoluteComponentPath: _, absolutePreviewPath: __, ...entry }) => entry,
      ),
    }),
    entries,
  };
}
