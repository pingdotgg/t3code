#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface AuldricDocsManifest {
  readonly schemaVersion: 1;
  readonly authorityDocument: string;
  readonly guidanceDocuments: ReadonlyArray<string>;
  readonly activeDocuments: ReadonlyArray<string>;
  readonly supersededDocuments: ReadonlyArray<string>;
  readonly historicalDocuments: ReadonlyArray<string>;
}

interface ForbiddenDirective {
  readonly name: string;
  readonly pattern: RegExp;
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const manifestPath = "docs/auldric-system/manifest.json";

const forbiddenDirectives = [
  {
    name: "Auldric runtime ownership",
    pattern: /Auldric owns (?:the )?(?:launch |customer-facing )?runtime/giu,
  },
  {
    name: "hard-fork launch directive",
    pattern:
      /Auldric (?:is|will launch|launches|remains)(?: as)? (?:an? )?(?:controlled )?hard fork/giu,
  },
  {
    name: "T3 vendor-source posture",
    pattern: /T3(?: Code)? (?:is|remains) (?:an? )?(?:vendor|source-derived runtime)/giu,
  },
  {
    name: "global Auldric interaction posture",
    pattern: /Auldric-owned interaction posture/giu,
  },
  {
    name: "legacy progressive prompt rollout",
    pattern: /AULDRIC_PROGRESSIVE_PROMPT_PROVIDERS/gu,
  },
] as const satisfies ReadonlyArray<ForbiddenDirective>;

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function decodeManifest(value: unknown): AuldricDocsManifest | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.authorityDocument !== "string" ||
    !isStringArray(record.guidanceDocuments) ||
    !isStringArray(record.activeDocuments) ||
    !isStringArray(record.supersededDocuments) ||
    !isStringArray(record.historicalDocuments)
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    authorityDocument: record.authorityDocument,
    guidanceDocuments: record.guidanceDocuments,
    activeDocuments: record.activeDocuments,
    supersededDocuments: record.supersededDocuments,
    historicalDocuments: record.historicalDocuments,
  };
}

export function findForbiddenAuthorityDirectives(content: string): ReadonlyArray<string> {
  return forbiddenDirectives.flatMap(({ name, pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(content) ? [name] : [];
  });
}

function discoverAuldricMarkdown(rootDir: string): ReadonlyArray<string> {
  const docsDir = NodePath.join(rootDir, "docs");
  const systemDir = NodePath.join(docsDir, "auldric-system");
  const rootDocuments = NodeFS.readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^auldric.*\.md$/u.test(entry.name))
    .map((entry) => `docs/${entry.name}`);
  const systemDocuments = NodeFS.readdirSync(systemDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `docs/auldric-system/${entry.name}`);

  return [...rootDocuments, ...systemDocuments].sort();
}

function readManifest(rootDir: string): AuldricDocsManifest | undefined {
  const content = NodeFS.readFileSync(NodePath.join(rootDir, manifestPath), "utf8");
  return decodeManifest(JSON.parse(content) as unknown);
}

function isInsideRoot(rootDir: string, relativePath: string): boolean {
  const resolvedRoot = NodePath.resolve(rootDir);
  const resolvedPath = NodePath.resolve(resolvedRoot, relativePath);
  return resolvedPath.startsWith(`${resolvedRoot}${NodePath.sep}`);
}

export function validateAuldricFeatureDocs(rootDir = repoRoot): ReadonlyArray<string> {
  const problems: Array<string> = [];
  let manifest: AuldricDocsManifest | undefined;

  try {
    manifest = readManifest(rootDir);
  } catch (error) {
    return [`Could not read ${manifestPath}: ${String(error)}`];
  }

  if (!manifest) {
    return [`${manifestPath} does not match schema version 1.`];
  }

  const classifiedDocuments = [
    ...manifest.activeDocuments,
    ...manifest.supersededDocuments,
    ...manifest.historicalDocuments,
  ];
  const registeredPaths = [...manifest.guidanceDocuments, ...classifiedDocuments];
  const duplicatePaths = registeredPaths.filter(
    (entry, index) => registeredPaths.indexOf(entry) !== index,
  );

  for (const duplicatePath of new Set(duplicatePaths)) {
    problems.push(`Document is registered more than once: ${duplicatePath}`);
  }

  if (!manifest.activeDocuments.includes(manifest.authorityDocument)) {
    problems.push(`Authority document is not active: ${manifest.authorityDocument}`);
  }

  for (const relativePath of registeredPaths) {
    if (!isInsideRoot(rootDir, relativePath)) {
      problems.push(`Registered path escapes the repository: ${relativePath}`);
      continue;
    }
    if (!NodeFS.existsSync(NodePath.join(rootDir, relativePath))) {
      problems.push(`Registered document is missing: ${relativePath}`);
    }
  }

  const classifiedActivePaths = new Set([
    ...manifest.activeDocuments,
    ...manifest.supersededDocuments,
  ]);
  for (const relativePath of discoverAuldricMarkdown(rootDir)) {
    if (!classifiedActivePaths.has(relativePath)) {
      problems.push(`Active Auldric document is not classified: ${relativePath}`);
    }
  }

  for (const relativePath of [...manifest.guidanceDocuments, ...manifest.activeDocuments]) {
    const absolutePath = NodePath.join(rootDir, relativePath);
    if (!NodeFS.existsSync(absolutePath)) {
      continue;
    }
    const content = NodeFS.readFileSync(absolutePath, "utf8");
    for (const directive of findForbiddenAuthorityDirectives(content)) {
      problems.push(`${relativePath} contains forbidden active guidance: ${directive}`);
    }
  }

  const requiredStatements = [
    {
      path: "AGENTS.md",
      text: "This repository keeps T3 authoritative for Dev and shared platform infrastructure.",
    },
    {
      path: manifest.authorityDocument,
      text: "Auldric compilation and evidence run only after explicit Marketing-domain selection.",
    },
    {
      path: manifest.authorityDocument,
      text: "Missing or unknown domain resolves to native Dev.",
    },
    {
      path: "docs/auldric-system/00-current-state.md",
      text: "Not implemented",
    },
  ] as const;

  for (const requirement of requiredStatements) {
    const absolutePath = NodePath.join(rootDir, requirement.path);
    const normalizedContent = NodeFS.existsSync(absolutePath)
      ? NodeFS.readFileSync(absolutePath, "utf8").replace(/\s+/gu, " ")
      : "";
    if (
      NodeFS.existsSync(absolutePath) &&
      !normalizedContent.includes(requirement.text.replace(/\s+/gu, " "))
    ) {
      problems.push(`${requirement.path} is missing required statement: ${requirement.text}`);
    }
  }

  for (const relativePath of manifest.supersededDocuments) {
    const absolutePath = NodePath.join(rootDir, relativePath);
    if (
      NodeFS.existsSync(absolutePath) &&
      !NodeFS.readFileSync(absolutePath, "utf8").startsWith("# Superseded:")
    ) {
      problems.push(`Superseded document lacks an unambiguous heading: ${relativePath}`);
    }
  }

  for (const relativePath of manifest.historicalDocuments) {
    if (!relativePath.startsWith("docs/_archive/")) {
      problems.push(`Historical document is outside docs/_archive: ${relativePath}`);
    }
  }

  return problems;
}

function main(): void {
  const problems = validateAuldricFeatureDocs();
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`- ${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const manifest = readManifest(repoRoot);
  process.stdout.write(
    `Auldric feature docs complete: ${manifest?.activeDocuments.length ?? 0} active documents registered; authority guard passed.\n`,
  );
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
if (invokedPath === NodeURL.fileURLToPath(import.meta.url)) {
  main();
}
