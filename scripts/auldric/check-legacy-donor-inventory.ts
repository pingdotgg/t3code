// @effect-diagnostics nodeBuiltinImport:off - This audit reads an external, read-only Git repository at an immutable ref.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const defaultInventoryPath = "docs/auldric-system/legacy-donor-inventory.json";

const classifications = [
  "keep-rebuild",
  "split",
  "replace-with-t3",
  "retire",
  "upstream-dependency",
  "historical-evidence",
] as const;

const dispositions = ["retain", "split", "rebuild", "replace", "archive", "delete"] as const;

type Classification = (typeof classifications)[number];

interface InventoryEntry {
  readonly id: string;
  readonly selector: {
    readonly include: ReadonlyArray<string>;
  };
  readonly pathCapability: string;
  readonly classification: Classification;
  readonly legacyEvidenceStatus: string;
  readonly currentAuldricsStatus: string;
  readonly owner: {
    readonly issues: ReadonlyArray<number>;
    readonly boundary: string;
    readonly rationale: string;
  };
  readonly integration: {
    readonly supportedSeam: string | null;
    readonly upstreamDependency: string | null;
  };
  readonly data: {
    readonly migration: string;
    readonly backfill: string;
    readonly rollback: string;
  };
  readonly securityTenantRisk: string;
  readonly testsAndProof: ReadonlyArray<string>;
  readonly disposition: (typeof dispositions)[number];
}

interface DonorInventory {
  readonly schemaVersion: 1;
  readonly matchPolicy: "first-match";
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly rootTree: string;
    readonly fileCount: number;
    readonly pathListSha256: string;
    readonly lsTreeSha256: string;
  };
  readonly authority: {
    readonly currentRepositoryState: string;
    readonly noMechanicalPort: string;
    readonly t3Wins: string;
  };
  readonly entries: ReadonlyArray<InventoryEntry>;
}

export interface InventoryReport {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly entryCounts: Readonly<Record<Classification, number>>;
  readonly fileCounts: Readonly<Record<Classification, number>>;
  readonly totalEntries: number;
  readonly totalFiles: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasNonEmptyString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string" && record[key].trim().length > 0;
}

function emptyClassCounts(): Record<Classification, number> {
  return {
    "keep-rebuild": 0,
    split: 0,
    "replace-with-t3": 0,
    retire: 0,
    "upstream-dependency": 0,
    "historical-evidence": 0,
  };
}

function decodeEntry(
  value: unknown,
  index: number,
  problems: Array<string>,
): InventoryEntry | null {
  if (!isRecord(value)) {
    problems.push(`entries[${index}] is not an object.`);
    return null;
  }

  const selector = value.selector;
  const owner = value.owner;
  const integration = value.integration;
  const data = value.data;
  const classification = value.classification;
  const disposition = value.disposition;
  const includePatterns =
    isRecord(selector) && isStringArray(selector.include) ? selector.include : [];

  const valid =
    hasNonEmptyString(value, "id") &&
    isRecord(selector) &&
    includePatterns.length > 0 &&
    hasNonEmptyString(value, "pathCapability") &&
    typeof classification === "string" &&
    classifications.includes(classification as Classification) &&
    hasNonEmptyString(value, "legacyEvidenceStatus") &&
    hasNonEmptyString(value, "currentAuldricsStatus") &&
    isRecord(owner) &&
    Array.isArray(owner.issues) &&
    owner.issues.length > 0 &&
    owner.issues.every((issue) => Number.isInteger(issue) && Number(issue) > 0) &&
    hasNonEmptyString(owner, "boundary") &&
    hasNonEmptyString(owner, "rationale") &&
    isRecord(integration) &&
    (integration.supportedSeam === null ||
      (typeof integration.supportedSeam === "string" && integration.supportedSeam.length > 0)) &&
    (integration.upstreamDependency === null ||
      (typeof integration.upstreamDependency === "string" &&
        integration.upstreamDependency.length > 0)) &&
    isRecord(data) &&
    hasNonEmptyString(data, "migration") &&
    hasNonEmptyString(data, "backfill") &&
    hasNonEmptyString(data, "rollback") &&
    hasNonEmptyString(value, "securityTenantRisk") &&
    isStringArray(value.testsAndProof) &&
    value.testsAndProof.length > 0 &&
    typeof disposition === "string" &&
    dispositions.includes(disposition as (typeof dispositions)[number]);

  if (!valid) {
    problems.push(`entries[${index}] does not contain the complete issue #14 record.`);
    return null;
  }

  for (const pattern of includePatterns) {
    try {
      RegExp(pattern, "u");
    } catch (error) {
      problems.push(
        `entries[${index}] has invalid selector ${JSON.stringify(pattern)}: ${String(error)}`,
      );
      return null;
    }
  }

  return value as unknown as InventoryEntry;
}

export function decodeInventory(value: unknown): {
  readonly inventory: DonorInventory | null;
  readonly problems: ReadonlyArray<string>;
} {
  const problems: Array<string> = [];
  if (!isRecord(value)) {
    return { inventory: null, problems: ["Inventory root is not an object."] };
  }

  const source = value.source;
  const authority = value.authority;
  if (
    value.schemaVersion !== 1 ||
    value.matchPolicy !== "first-match" ||
    !isRecord(source) ||
    !hasNonEmptyString(source, "repository") ||
    !hasNonEmptyString(source, "commit") ||
    !hasNonEmptyString(source, "rootTree") ||
    !Number.isInteger(source.fileCount) ||
    Number(source.fileCount) <= 0 ||
    !hasNonEmptyString(source, "pathListSha256") ||
    !hasNonEmptyString(source, "lsTreeSha256") ||
    !isRecord(authority) ||
    !hasNonEmptyString(authority, "currentRepositoryState") ||
    !hasNonEmptyString(authority, "noMechanicalPort") ||
    !hasNonEmptyString(authority, "t3Wins") ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    return { inventory: null, problems: ["Inventory root does not match schema version 1."] };
  }

  const entries = value.entries.flatMap((entry, index) => {
    const decoded = decodeEntry(entry, index, problems);
    return decoded ? [decoded] : [];
  });
  const ids = entries.map(({ id }) => id);
  for (const duplicate of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
    problems.push(`Duplicate inventory entry id: ${duplicate}`);
  }

  if (entries.length !== value.entries.length) {
    return { inventory: null, problems };
  }

  return { inventory: value as unknown as DonorInventory, problems };
}

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function git(repo: string, ...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function compileEntry(entry: InventoryEntry): {
  readonly entry: InventoryEntry;
  readonly patterns: ReadonlyArray<RegExp>;
} {
  return { entry, patterns: entry.selector.include.map((pattern) => new RegExp(pattern, "u")) };
}

export function classifyPaths(
  inventory: DonorInventory,
  paths: ReadonlyArray<string>,
  requireEveryEntry = true,
): {
  readonly problems: ReadonlyArray<string>;
  readonly fileCounts: Readonly<Record<Classification, number>>;
} {
  const problems: Array<string> = [];
  const compiled = inventory.entries.map(compileEntry);
  const fileCounts = emptyClassCounts();
  const perEntry = new Map(inventory.entries.map(({ id }) => [id, 0]));

  for (const path of paths) {
    const match = compiled.find(({ patterns }) => patterns.some((pattern) => pattern.test(path)));
    if (!match) {
      problems.push(`Unclassified donor path: ${path}`);
      continue;
    }
    fileCounts[match.entry.classification] += 1;
    perEntry.set(match.entry.id, (perEntry.get(match.entry.id) ?? 0) + 1);
  }

  if (requireEveryEntry) {
    for (const [id, count] of perEntry) {
      if (count === 0) {
        problems.push(`Inventory selector resolves no donor files: ${id}`);
      }
    }
  }

  return { problems, fileCounts };
}

export function validateInventory(inventoryPath: string, donorRepo?: string): InventoryReport {
  const parsed = JSON.parse(NodeFS.readFileSync(inventoryPath, "utf8")) as unknown;
  const decoded = decodeInventory(parsed);
  const problems = [...decoded.problems];
  const entryCounts = emptyClassCounts();
  const fileCounts = emptyClassCounts();

  if (!decoded.inventory) {
    return { ok: false, problems, entryCounts, fileCounts, totalEntries: 0, totalFiles: 0 };
  }

  for (const entry of decoded.inventory.entries) {
    entryCounts[entry.classification] += 1;
  }

  if (!donorRepo) {
    return {
      ok: problems.length === 0,
      problems,
      entryCounts,
      fileCounts,
      totalEntries: decoded.inventory.entries.length,
      totalFiles: 0,
    };
  }

  const source = decoded.inventory.source;
  let commit = "";
  let tree = "";
  let lsTree = "";
  try {
    commit = git(donorRepo, "rev-parse", `${source.commit}^{commit}`).trim();
    tree = git(donorRepo, "show", "-s", "--format=%T", source.commit).trim();
    lsTree = git(donorRepo, "ls-tree", "-r", source.commit);
  } catch (error) {
    problems.push(`Could not read donor repository: ${String(error)}`);
  }

  if (commit && commit !== source.commit) {
    problems.push(`Donor ref resolved to ${commit}; expected ${source.commit}.`);
  }
  if (tree && tree !== source.rootTree) {
    problems.push(`Donor root tree is ${tree}; expected ${source.rootTree}.`);
  }
  if (lsTree && sha256(lsTree) !== source.lsTreeSha256) {
    problems.push(`Donor ls-tree digest does not match ${source.lsTreeSha256}.`);
  }

  const paths = lsTree
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf("\t") + 1));
  const pathList = paths.length > 0 ? `${paths.join("\n")}\n` : "";
  if (paths.length !== source.fileCount) {
    problems.push(`Donor contains ${paths.length} files; expected ${source.fileCount}.`);
  }
  if (pathList && sha256(pathList) !== source.pathListSha256) {
    problems.push(`Donor path-list digest does not match ${source.pathListSha256}.`);
  }

  const classification = classifyPaths(decoded.inventory, paths);
  problems.push(...classification.problems);
  Object.assign(fileCounts, classification.fileCounts);

  return {
    ok: problems.length === 0,
    problems,
    entryCounts,
    fileCounts,
    totalEntries: decoded.inventory.entries.length,
    totalFiles: paths.length,
  };
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const repoRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../..",
  );
  const inventoryPath = NodePath.resolve(
    repoRoot,
    argumentValue("--inventory") ?? defaultInventoryPath,
  );
  const donorRepo = argumentValue("--donor-repo");
  const report = validateInventory(inventoryPath, donorRepo);

  if (!report.ok) {
    for (const problem of report.problems) {
      process.stderr.write(`- ${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        inventory: NodePath.relative(repoRoot, inventoryPath),
        donorVerified: Boolean(donorRepo),
        totalEntries: report.totalEntries,
        totalFiles: report.totalFiles,
        entryCounts: report.entryCounts,
        fileCounts: report.fileCounts,
      },
      null,
      2,
    )}\n`,
  );
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
if (invokedPath === NodeURL.fileURLToPath(import.meta.url)) {
  main();
}
