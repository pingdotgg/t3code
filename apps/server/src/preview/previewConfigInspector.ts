import path from "node:path";

import { runProcess } from "../processRunner.ts";

const PREVIEW_CONFIG_INSPECTOR_TYPESCRIPT_REQUIRE_PATH = path.resolve(
  import.meta.dirname,
  "../../package.json",
);

const PREVIEW_CONFIG_INSPECTOR_SOURCE = [
  'import fs from "node:fs/promises";',
  'import { createRequire } from "node:module";',
  "",
  "const require = createRequire(",
  "  process.env.FORMA_PREVIEW_TYPESCRIPT_REQUIRE_PATH ?? import.meta.url,",
  ");",
  'const ts = require("typescript");',
  "",
  "function fail(message) {",
  "  console.error(message);",
  "  process.exit(1);",
  "}",
  "",
  "function unwrapExpression(node) {",
  "  if (!node) return null;",
  "  if (ts.isParenthesizedExpression(node)) return unwrapExpression(node.expression);",
  "  if (ts.isCallExpression(node) && node.arguments.length > 0) return unwrapExpression(node.arguments[0]);",
  "  return node;",
  "}",
  "",
  "function propertyExpression(node, propertyName) {",
  "  if (!node) return null;",
  "  if (!ts.isObjectLiteralExpression(node)) return null;",
  "  for (const property of node.properties) {",
  "    if (!ts.isPropertyAssignment(property)) continue;",
  "    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;",
  "    if (name === propertyName) return property.initializer;",
  "  }",
  "  return null;",
  "}",
  "",
  "function stringValue(node) {",
  "  if (!node) return null;",
  "  if (ts.isStringLiteralLike(node)) return node.text;",
  "  return null;",
  "}",
  "",
  "function stringArray(node) {",
  "  if (!node) return null;",
  "  if (!ts.isArrayLiteralExpression(node)) return null;",
  "  const values = [];",
  "  for (const element of node.elements) {",
  "    const value = stringValue(element);",
  "    if (value === null) return null;",
  "    values.push(value);",
  "  }",
  "  return values;",
  "}",
  "",
  "function stringRecord(node) {",
  "  if (!node) return null;",
  "  if (!ts.isObjectLiteralExpression(node)) return null;",
  "  const record = {};",
  "  for (const property of node.properties) {",
  "    if (!ts.isPropertyAssignment(property)) return null;",
  "    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;",
  "    if (!key) return null;",
  "    const value = stringValue(property.initializer);",
  "    if (value === null) return null;",
  "    record[key] = value;",
  "  }",
  "  return record;",
  "}",
  "",
  "function objectValue(node) {",
  "  if (!node) return null;",
  "  return ts.isObjectLiteralExpression(node) ? node : null;",
  "}",
  "",
  "async function main() {",
  "  const configPath = process.env.FORMA_PREVIEW_CONFIG_PATH;",
  "  if (!configPath) fail('FORMA_PREVIEW_CONFIG_PATH is required.');",
  "  const source = await fs.readFile(configPath, 'utf8');",
  "  const sourceFile = ts.createSourceFile(configPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);",
  "  const exportAssignment = sourceFile.statements.find((statement) => ts.isExportAssignment(statement));",
  "  if (!exportAssignment || !ts.isExportAssignment(exportAssignment)) fail('Default preview config export was not found.');",
  "  const rootExpression = unwrapExpression(exportAssignment.expression);",
  "  if (!ts.isObjectLiteralExpression(rootExpression)) fail('Preview config default export must resolve to an object literal.');",
  "  const appRoot = stringValue(propertyExpression(rootExpression, 'appRoot'));",
  "  const framework = stringValue(propertyExpression(rootExpression, 'framework')) ?? undefined;",
  "  const bundler = stringValue(propertyExpression(rootExpression, 'bundler')) ?? undefined;",
  "  const serverObject = objectValue(propertyExpression(rootExpression, 'server'));",
  "  if (!appRoot || !serverObject) fail('Preview config requires appRoot and server.');",
  "  const command = stringArray(propertyExpression(serverObject, 'command'));",
  "  if (!command || command.length === 0) fail('Preview config server.command must be a non-empty string array.');",
  "  const cwd = stringValue(propertyExpression(serverObject, 'cwd')) ?? undefined;",
  "  const env = stringRecord(propertyExpression(serverObject, 'env')) ?? undefined;",
  "  const scanObject = objectValue(propertyExpression(rootExpression, 'scan'));",
  "  const include = scanObject ? stringArray(propertyExpression(scanObject, 'include')) ?? undefined : undefined;",
  "  const exclude = scanObject ? stringArray(propertyExpression(scanObject, 'exclude')) ?? undefined : undefined;",
  "  const componentsObject = objectValue(propertyExpression(rootExpression, 'components'));",
  "  const componentInclude = componentsObject ? stringArray(propertyExpression(componentsObject, 'include')) ?? undefined : undefined;",
  "  const componentExclude = componentsObject ? stringArray(propertyExpression(componentsObject, 'exclude')) ?? undefined : undefined;",
  "  const graphObject = objectValue(propertyExpression(rootExpression, 'graph'));",
  "  const graphInclude = graphObject ? stringArray(propertyExpression(graphObject, 'include')) ?? undefined : undefined;",
  "  const graphExclude = graphObject ? stringArray(propertyExpression(graphObject, 'exclude')) ?? undefined : undefined;",
  "  const payload = {",
  "    appRoot,",
  "    ...(framework ? { framework } : {}),",
  "    ...(bundler ? { bundler } : {}),",
  "    server: { command, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) },",
  "    ...(",
  "      include || exclude",
  "        ? { scan: { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) } }",
  "        : {}",
  "    ),",
  "    ...(",
  "      componentInclude || componentExclude",
  "        ? { components: { ...(componentInclude ? { include: componentInclude } : {}), ...(componentExclude ? { exclude: componentExclude } : {}) } }",
  "        : {}",
  "    ),",
  "    ...(",
  "      graphInclude || graphExclude",
  "        ? { graph: { ...(graphInclude ? { include: graphInclude } : {}), ...(graphExclude ? { exclude: graphExclude } : {}) } }",
  "        : {}",
  "    ),",
  "  };",
  "  process.stdout.write(JSON.stringify(payload));",
  "}",
  "",
  "main().catch((error) => {",
  "  fail(error instanceof Error ? error.message : 'Failed to inspect preview config.');",
  "});",
].join("\n");

export interface SerializablePreviewConfig {
  readonly appRoot: string;
  readonly framework?: "react" | undefined;
  readonly bundler?: "vite" | undefined;
  readonly server: {
    readonly command: readonly [string, ...string[]];
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  };
  readonly scan?: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
  };
  readonly components?: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
  };
  readonly graph?: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
  };
}

export async function inspectPreviewConfig(configPath: string): Promise<SerializablePreviewConfig> {
  const result = await runProcess(
    process.execPath,
    ["--input-type=module", "--eval", PREVIEW_CONFIG_INSPECTOR_SOURCE],
    {
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        FORMA_PREVIEW_CONFIG_PATH: configPath,
        FORMA_PREVIEW_TYPESCRIPT_REQUIRE_PATH: PREVIEW_CONFIG_INSPECTOR_TYPESCRIPT_REQUIRE_PATH,
      },
      outputMode: "truncate",
      timeoutMs: 15_000,
    },
  );
  return JSON.parse(result.stdout) as SerializablePreviewConfig;
}
