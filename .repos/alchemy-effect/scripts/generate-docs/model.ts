import * as path from "node:path";

import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type Symbol,
  type TypeAliasDeclaration,
  type TypeNode,
} from "ts-morph";

import {
  getBindingPolicyClasses,
  getBindingServiceClasses,
  getFileKind,
  getPrimaryNode,
  getProviderDeclaration,
  getResourceTypeDetails,
} from "./discovery.ts";
import {
  docsRoot,
  formatTypeText,
  getDefaultValue,
  getJSDocInfo,
  getSummary,
  guessExampleValue,
  labelFromDocRelativePath,
  lowerCamel,
  relativeDocLink,
  relativeSourcePath,
  srcRoot,
  titleFromRelativePath,
  truncateInline,
} from "./utils.ts";
import type {
  BindingClassDoc,
  DirectoryCatalog,
  ExportDoc,
  FileDoc,
  FileKind,
  LinkDoc,
  OperationDoc,
  PropertyDoc,
  ResourceDoc,
  ShapeDoc,
  SourceEntry,
} from "./types.ts";
import { lifecycleOperationOrder } from "./types.ts";

function propertySignatureToDoc(
  property: import("ts-morph").PropertySignature,
): PropertyDoc {
  return {
    name: property.getName(),
    type: formatTypeText(
      property.getTypeNode()?.getText() ?? property.getType().getText(property),
    ),
    optional: property.hasQuestionToken(),
    readonly: property.isReadonly(),
    description: getSummary(property),
    defaultValue: getDefaultValue(property),
  };
}

function getShapeFromMembers(
  title: string,
  members: Node[],
  description?: string,
): ShapeDoc | undefined {
  const properties = members
    .flatMap((member) =>
      Node.isPropertySignature(member) ? [propertySignatureToDoc(member)] : [],
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  if (properties.length === 0) {
    return undefined;
  }

  return {
    title,
    description,
    properties,
  };
}

function resolveShapeDeclaration(
  symbol: Symbol | undefined,
): InterfaceDeclaration | TypeAliasDeclaration | undefined {
  return symbol
    ?.getDeclarations()
    .find(
      (declaration) =>
        Node.isInterfaceDeclaration(declaration) ||
        Node.isTypeAliasDeclaration(declaration),
    ) as InterfaceDeclaration | TypeAliasDeclaration | undefined;
}

function getShapeFromTypeNode(
  title: string,
  typeNode: TypeNode,
  description?: string,
): ShapeDoc | undefined {
  if (Node.isTypeLiteral(typeNode)) {
    return getShapeFromMembers(title, typeNode.getMembers(), description);
  }

  if (Node.isTypeReference(typeNode)) {
    const declaration = resolveShapeDeclaration(
      typeNode.getTypeName().getSymbol(),
    );
    if (declaration) {
      return getShapeFromDeclaration(title, declaration);
    }
  }

  return {
    title,
    description,
    properties: [],
    signature: formatTypeText(typeNode.getText()),
  };
}

function getShapeFromDeclaration(
  title: string,
  declaration: InterfaceDeclaration | TypeAliasDeclaration,
): ShapeDoc | undefined {
  if (Node.isInterfaceDeclaration(declaration)) {
    return getShapeFromMembers(
      title,
      declaration.getMembers(),
      getSummary(declaration),
    );
  }

  const typeNode = declaration.getTypeNode();
  if (!typeNode) {
    return undefined;
  }
  return getShapeFromTypeNode(title, typeNode, getSummary(declaration));
}

function signatureForDeclaration(declaration: Node) {
  if (Node.isClassDeclaration(declaration)) {
    const heritage = declaration
      .getHeritageClauses()
      .flatMap((clause) => clause.getTypeNodes())
      .map((typeNode) => typeNode.getText())
      .join(", ");
    return `class ${declaration.getName() ?? "Anonymous"}${heritage ? ` extends ${heritage}` : ""}`;
  }

  if (Node.isFunctionDeclaration(declaration)) {
    const params = declaration
      .getParameters()
      .map((param) => param.getText())
      .join(", ");
    const returnType = declaration.getReturnTypeNode()?.getText();
    return `function ${declaration.getName() ?? "anonymous"}(${params})${returnType ? `: ${returnType}` : ""}`;
  }

  if (Node.isInterfaceDeclaration(declaration)) {
    return `interface ${declaration.getName()}`;
  }

  if (Node.isTypeAliasDeclaration(declaration)) {
    return `type ${declaration.getName()} = ${formatTypeText(
      declaration.getTypeNode()?.getText(),
    )}`;
  }

  if (Node.isVariableDeclaration(declaration)) {
    const kind =
      declaration.getVariableStatement()?.getDeclarationKind() ?? "const";
    const initializer = declaration.getInitializer()?.getText();
    return `${kind} ${declaration.getName()}${initializer ? ` = ${truncateInline(initializer)}` : ""}`;
  }

  if (Node.isModuleDeclaration(declaration)) {
    return `namespace ${declaration.getName()}`;
  }

  if (Node.isEnumDeclaration(declaration)) {
    return `enum ${declaration.getName()}`;
  }

  return truncateInline(declaration.getText());
}

function getLocalExports(sourceFile: SourceFile): ExportDoc[] {
  const exports: ExportDoc[] = [];

  for (const declaration of sourceFile
    .getClasses()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName() ?? "Anonymous",
      kind: "class",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration),
    });
  }

  for (const declaration of sourceFile
    .getFunctions()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName() ?? "anonymous",
      kind: "function",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration),
    });
  }

  for (const declaration of sourceFile
    .getInterfaces()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName(),
      kind: "interface",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration),
      shape: getShapeFromDeclaration(declaration.getName(), declaration),
    });
  }

  for (const declaration of sourceFile
    .getTypeAliases()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName(),
      kind: "type",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration),
      shape: getShapeFromDeclaration(declaration.getName(), declaration),
    });
  }

  for (const declaration of sourceFile
    .getVariableDeclarations()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName(),
      kind: "const",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration.getVariableStatement() ?? declaration),
    });
  }

  for (const declaration of sourceFile
    .getEnums()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName(),
      kind: "enum",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration),
    });
  }

  for (const declaration of sourceFile
    .getModules()
    .filter((item) => item.isExported())) {
    exports.push({
      name: declaration.getName(),
      kind: "namespace",
      signature: signatureForDeclaration(declaration),
      summary: getSummary(declaration),
    });
  }

  const seen = new Set<string>();
  return exports
    .filter((entry) => {
      const key = `${entry.kind}:${entry.name}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getLifecycleOperations(sourceFile: SourceFile, resourceName: string) {
  const provider = getProviderDeclaration(sourceFile, resourceName);
  if (!provider) {
    return [];
  }
  const text = provider.getText();
  return lifecycleOperationOrder.filter((name) =>
    new RegExp(`\\b${name}\\s*:`).test(text),
  );
}

function getResourceDoc(sourceFile: SourceFile, fileKind: FileKind) {
  const details = getResourceTypeDetails(
    sourceFile,
    fileKind === "host" ? "Host" : "Resource",
  );
  if (!details) {
    return undefined;
  }

  const resourceInterface = sourceFile.getInterface(details.name);
  const props =
    sourceFile.getInterface(`${details.name}Props`) ??
    sourceFile.getTypeAlias(`${details.name}Props`);

  let attributes: ShapeDoc | undefined;
  let binding: ShapeDoc | undefined;

  if (resourceInterface) {
    const resourceHeritage = resourceInterface
      .getHeritageClauses()
      .flatMap((clause) => clause.getTypeNodes())
      .find((typeNode) => typeNode.getExpression().getText() === "Resource");

    if (resourceHeritage) {
      const typeArguments = resourceHeritage.getTypeArguments();
      const attrsNode = typeArguments[2];
      const bindingNode = typeArguments[3];
      if (attrsNode) {
        attributes = getShapeFromTypeNode(
          `${details.name} Attributes`,
          attrsNode,
        );
      }
      if (bindingNode) {
        binding = getShapeFromTypeNode(
          `${details.name} Binding Contract`,
          bindingNode,
        );
      }
    }
  }

  const resourceDoc: ResourceDoc = {
    name: details.name,
    resourceType: details.resourceType,
    props: props
      ? getShapeFromDeclaration(`${details.name} Props`, props)
      : undefined,
    attributes,
    binding,
    lifecycleOperations: getLifecycleOperations(sourceFile, details.name),
    providerName: getProviderDeclaration(sourceFile, details.name)?.getName(),
  };

  return resourceDoc;
}

function getBindingIdentifier(declaration: ClassDeclaration) {
  const text = declaration.getText();
  return text.match(/\)\("([^"]+)"\)/)?.[1];
}

function bindingDocForClass(declaration: ClassDeclaration): BindingClassDoc {
  return {
    name: declaration.getName() ?? "Anonymous",
    identifier: getBindingIdentifier(declaration),
    signature: signatureForDeclaration(declaration),
    summary: getSummary(declaration),
  };
}

function getRequestShapes(sourceFile: SourceFile) {
  return [
    ...sourceFile
      .getInterfaces()
      .filter(
        (item) =>
          item.isExported() &&
          /Request|Props|Options|Input$/.test(item.getName()),
      ),
    ...sourceFile
      .getTypeAliases()
      .filter(
        (item) =>
          item.isExported() &&
          /Request|Props|Options|Input$/.test(item.getName()),
      ),
  ]
    .map((declaration) =>
      getShapeFromDeclaration(declaration.getName(), declaration),
    )
    .filter((shape): shape is ShapeDoc => shape !== undefined)
    .sort((left, right) => left.title.localeCompare(right.title));
}

function getSupportedHosts(sourceFile: SourceFile) {
  const hosts = new Set<string>();
  const text = sourceFile.getText();
  if (text.includes("isFunction(host)")) {
    hosts.add("AWS.Lambda.Function");
  }
  if (text.includes("isWorker(host)")) {
    hosts.add("Cloudflare.Workers.Worker");
  }
  return [...hosts].sort();
}

function parameterToUsage(parameter: ParameterDeclaration) {
  return {
    name: parameter.getName(),
    type: formatTypeText(
      parameter.getTypeNode()?.getText() ??
        parameter.getType().getText(parameter),
    ),
    optional: parameter.isOptional(),
    rest: parameter.isRestParameter(),
  };
}

function getOperationUsage(
  sourceFile: SourceFile,
  serviceName: string | undefined,
) {
  if (!serviceName) {
    return undefined;
  }

  const live = sourceFile.getVariableDeclaration(`${serviceName}Live`);
  const initializer = live?.getInitializer();
  if (!initializer) {
    return undefined;
  }

  const effectFns = initializer
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === "Effect.fn");

  const [bindFn, invokeFn] = effectFns.map((call) => {
    const firstArg = call.getArguments()[0];
    if (
      firstArg &&
      (Node.isFunctionExpression(firstArg) || Node.isArrowFunction(firstArg))
    ) {
      return firstArg;
    }
    return undefined;
  });

  if (!bindFn && !invokeFn) {
    return undefined;
  }

  return {
    bindParameters: bindFn?.getParameters().map(parameterToUsage) ?? [],
    invokeParameters: invokeFn?.getParameters().map(parameterToUsage) ?? [],
  };
}

function getOperationDoc(sourceFile: SourceFile): OperationDoc | undefined {
  const services = getBindingServiceClasses(sourceFile).map(bindingDocForClass);
  const policies = getBindingPolicyClasses(sourceFile).map(bindingDocForClass);
  const runtimeLayers = sourceFile
    .getVariableDeclarations()
    .filter(
      (declaration) =>
        declaration.isExported() &&
        /Live$/.test(declaration.getName()) &&
        declaration.getInitializer()?.getText().includes("Layer.") === true,
    )
    .map((declaration) => declaration.getName())
    .sort();
  const requestShapes = getRequestShapes(sourceFile);

  if (
    services.length === 0 &&
    policies.length === 0 &&
    runtimeLayers.length === 0 &&
    requestShapes.length === 0
  ) {
    return undefined;
  }

  return {
    services,
    policies,
    runtimeLayers,
    supportedHosts: getSupportedHosts(sourceFile),
    requestShapes,
    usage: getOperationUsage(sourceFile, services[0]?.name),
  };
}

function getIndexDoc(sourceFile: SourceFile, outputPath: string) {
  return {
    reExports: sourceFile
      .getExportDeclarations()
      .flatMap((declaration) => {
        const moduleSpecifier = declaration.getModuleSpecifierValue();
        if (!moduleSpecifier) {
          return [];
        }
        const target = declaration.getModuleSpecifierSourceFile();
        const href = target
          ? relativeDocLink(
              outputPath,
              path.join(
                docsRoot,
                path
                  .relative(srcRoot, target.getFilePath())
                  .replace(/\.ts$/, ".md"),
              ),
            )
          : undefined;
        const namespaceExport = declaration.getNamespaceExport();
        const exportNames =
          declaration.getNamedExports().length > 0
            ? declaration.getNamedExports().map((item) => item.getName())
            : namespaceExport
              ? [namespaceExport.getName()]
              : ["*"];

        return exportNames.map((exportName) => ({
          exportName,
          sourcePath: moduleSpecifier,
          href,
        }));
      })
      .sort((left, right) =>
        `${left.exportName}:${left.sourcePath}`.localeCompare(
          `${right.exportName}:${right.sourcePath}`,
        ),
      ),
  };
}

function getProviderDoc(sourceFile: SourceFile) {
  const exportedFactories = sourceFile
    .getVariableDeclarations()
    .filter((declaration) => declaration.isExported())
    .map((declaration) => declaration.getName())
    .filter(
      (name) =>
        [
          "providers",
          "resources",
          "bindings",
          "credentials",
          "stageConfig",
        ].includes(name) || /Provider/.test(name),
    )
    .sort();

  return exportedFactories.length > 0 ? { exportedFactories } : undefined;
}

function buildRelatedLinks(
  sourceFile: SourceFile,
  outputPath: string,
): LinkDoc[] {
  const links = new Map<string, LinkDoc>();

  const maybeAdd = (target: SourceFile | undefined, label: string) => {
    if (!target || !target.getFilePath().startsWith(srcRoot)) {
      return;
    }
    const relativeTargetPath = path.relative(srcRoot, target.getFilePath());
    const href = relativeDocLink(
      outputPath,
      path.join(docsRoot, relativeTargetPath.replace(/\.ts$/, ".md")),
    );
    links.set(`${label}:${href}`, {
      label:
        path.basename(relativeTargetPath, ".ts") === "index"
          ? path.basename(path.dirname(relativeTargetPath))
          : label,
      href,
    });
  };

  for (const declaration of sourceFile.getImportDeclarations()) {
    maybeAdd(
      declaration.getModuleSpecifierSourceFile(),
      path.basename(declaration.getModuleSpecifierValue(), ".ts"),
    );
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = declaration.getModuleSpecifierValue() ?? "index.ts";
    maybeAdd(
      declaration.getModuleSpecifierSourceFile(),
      path.basename(moduleSpecifier, ".ts"),
    );
  }

  return [...links.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function buildDirectoryCatalog(
  entry: SourceEntry,
  entries: SourceEntry[],
): DirectoryCatalog {
  const directory = path.dirname(entry.relativePath);
  const isIndexPage = path.basename(entry.relativePath) === "index.ts";
  const parent = !isIndexPage
    ? {
        label: directory === "." ? "API Reference" : path.basename(directory),
        href: relativeDocLink(
          entry.outputPath,
          path.join(
            docsRoot,
            directory === "." ? "index.md" : directory,
            "index.md",
          ),
        ),
      }
    : directory === "."
      ? undefined
      : {
          label:
            path.dirname(directory) === "."
              ? "API Reference"
              : path.basename(path.dirname(directory)),
          href: relativeDocLink(
            entry.outputPath,
            path.join(
              docsRoot,
              path.dirname(directory) === "."
                ? "index.md"
                : path.dirname(directory),
              "index.md",
            ),
          ),
        };

  const siblings = entries
    .filter(
      (candidate) =>
        path.dirname(candidate.relativePath) === directory &&
        candidate.relativePath !== entry.relativePath,
    )
    .map((candidate) => ({
      label: labelFromDocRelativePath(candidate.relativePath),
      href: relativeDocLink(entry.outputPath, candidate.outputPath),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return { parent, siblings };
}

function buildSummary(sourceFile: SourceFile, fileKind: FileKind) {
  const primaryNode = getPrimaryNode(sourceFile, fileKind);
  const summary = primaryNode ? getSummary(primaryNode) : undefined;
  if (summary) {
    return summary;
  }
  return "";
}

function singularize(name: string) {
  return name.endsWith("ies")
    ? `${name.slice(0, -3)}y`
    : name.endsWith("ses")
      ? name.slice(0, -2)
      : name.endsWith("s") && name.length > 1
        ? name.slice(0, -1)
        : name;
}

function guessBindingArgument(name: string, rest: boolean) {
  const base = rest ? singularize(name) : name;
  return lowerCamel(base || "resource");
}

function buildRequestBlock(shape: ShapeDoc | undefined) {
  if (!shape) {
    return "{\n  // request fields\n}";
  }

  const required = shape.properties.filter((property) => !property.optional);
  const properties = (required.length > 0 ? required : shape.properties).slice(
    0,
    4,
  );

  if (properties.length === 0) {
    return "{}";
  }

  return `{\n${properties
    .map((property) => `  ${property.name}: ${guessExampleValue(property)},`)
    .join("\n")}\n}`;
}

function buildAutoExample(
  fileKind: FileKind,
  title: string,
  resource?: ResourceDoc,
  operation?: OperationDoc,
) {
  if (fileKind === "resource" || fileKind === "host") {
    const required = (resource?.props?.properties ?? []).filter(
      (property) => !property.optional,
    );
    const propsBlock =
      required.length === 0
        ? "{}"
        : `{\n${required
            .map(
              (property) =>
                `  ${property.name}: ${guessExampleValue(property)},`,
            )
            .join("\n")}\n}`;
    return {
      title: `Create ${title}`,
      body: [
        "```typescript",
        `const ${lowerCamel(title)} = yield* ${title}("${title}", ${propsBlock});`,
        "```",
      ].join("\n"),
    };
  }

  if (fileKind === "operation") {
    const service = operation?.services[0]?.name ?? title;
    const bindArguments =
      operation?.usage?.bindParameters.map((parameter) =>
        guessBindingArgument(parameter.name, parameter.rest),
      ) ?? [];
    const bindCall =
      bindArguments.length > 0
        ? `.bind(${bindArguments.join(", ")})`
        : ".bind()";
    const invokeParameter = operation?.usage?.invokeParameters[0];
    const requestShape = operation?.requestShapes[0];
    const invocation = invokeParameter
      ? invokeParameter.optional
        ? `const response = yield* ${lowerCamel(service)}();`
        : `const response = yield* ${lowerCamel(service)}(${buildRequestBlock(requestShape)});`
      : `const response = yield* ${lowerCamel(service)}();`;

    return {
      title: `Use ${service}`,
      body: [
        "```typescript",
        `const ${lowerCamel(service)} = yield* ${service}${bindCall};`,
        "",
        invocation,
        "```",
      ].join("\n"),
    };
  }

  if (fileKind === "event-source") {
    return {
      title: `Attach ${title}`,
      body: [
        "```typescript",
        `yield* ${title}.bind(resource, {}, (events) =>`,
        "  Effect.log(events),",
        ");",
        "```",
      ].join("\n"),
    };
  }

  return undefined;
}

export function buildFileDoc(
  project: import("ts-morph").Project,
  entry: SourceEntry,
  entries: SourceEntry[],
): FileDoc {
  const sourceFile = project.getSourceFileOrThrow(entry.sourcePath);
  const fileKind = getFileKind(sourceFile);
  const title = titleFromRelativePath(entry.relativePath);
  const examples = (() => {
    const primaryNode = getPrimaryNode(sourceFile, fileKind);
    return primaryNode ? getJSDocInfo(primaryNode).sections : [];
  })();
  const resource =
    fileKind === "resource" || fileKind === "host"
      ? getResourceDoc(sourceFile, fileKind)
      : undefined;
  const operation =
    fileKind === "operation" || fileKind === "event-source"
      ? getOperationDoc(sourceFile)
      : undefined;

  return {
    title,
    fileKind,
    summary: buildSummary(sourceFile, fileKind),
    sourcePath: relativeSourcePath(sourceFile.getFilePath()),
    relativePath: entry.relativePath,
    outputPath: entry.outputPath,
    exports: getLocalExports(sourceFile),
    resource,
    operation,
    index:
      fileKind === "index"
        ? getIndexDoc(sourceFile, entry.outputPath)
        : undefined,
    provider: fileKind === "provider" ? getProviderDoc(sourceFile) : undefined,
    examples,
    autoExample:
      examples.length === 0
        ? buildAutoExample(fileKind, title, resource, operation)
        : undefined,
    relatedLinks: buildRelatedLinks(sourceFile, entry.outputPath),
    directoryCatalog: buildDirectoryCatalog(entry, entries),
  };
}
