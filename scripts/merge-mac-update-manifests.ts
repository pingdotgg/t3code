import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface MacUpdateFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

type MacUpdateScalar = string | number | boolean;

interface MacUpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<MacUpdateFile>;
  readonly extras: Readonly<Record<string, MacUpdateScalar>>;
}

interface MutableMacUpdateFile {
  url?: string;
  sha512?: string;
  size?: number;
}

function stripSingleQuotes(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseFileRecord(
  currentFile: MutableMacUpdateFile | null,
  sourcePath: string,
  lineNumber: number,
): MacUpdateFile | null {
  if (currentFile === null) {
    return null;
  }
  if (
    typeof currentFile.url !== "string" ||
    typeof currentFile.sha512 !== "string" ||
    typeof currentFile.size !== "number"
  ) {
    throw new Error(
      `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: incomplete file entry.`,
    );
  }
  return {
    url: currentFile.url,
    sha512: currentFile.sha512,
    size: currentFile.size,
  };
}

function parseScalarValue(rawValue: string): MacUpdateScalar {
  const trimmed = rawValue.trim();
  const isQuoted = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
  const value = isQuoted ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
  if (isQuoted) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

export function parseMacUpdateManifest(raw: string, sourcePath: string): MacUpdateManifest {
  const lines = raw.split(/\r?\n/);
  const files: MacUpdateFile[] = [];
  const extras: Record<string, MacUpdateScalar> = {};
  let version: string | null = null;
  let releaseDate: string | null = null;
  let inFiles = false;
  let currentFile: MutableMacUpdateFile | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/);
    if (fileUrlMatch?.[1]) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = { url: stripSingleQuotes(fileUrlMatch[1].trim()) };
      inFiles = true;
      continue;
    }

    const fileShaMatch = line.match(/^    sha512:\s*(.+)$/);
    if (fileShaMatch?.[1]) {
      if (currentFile === null) {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: sha512 without a file entry.`,
        );
      }
      currentFile.sha512 = stripSingleQuotes(fileShaMatch[1].trim());
      continue;
    }

    const fileSizeMatch = line.match(/^    size:\s*(\d+)$/);
    if (fileSizeMatch?.[1]) {
      if (currentFile === null) {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: size without a file entry.`,
        );
      }
      currentFile.size = Number(fileSizeMatch[1]);
      continue;
    }

    if (line === "files:") {
      inFiles = true;
      continue;
    }

    if (inFiles && currentFile !== null) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = null;
    }
    inFiles = false;

    const topLevelMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!topLevelMatch?.[1] || topLevelMatch[2] === undefined) {
      throw new Error(
        `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: unsupported line '${line}'.`,
      );
    }

    const [, key, rawValue] = topLevelMatch;
    const value = parseScalarValue(rawValue);

    if (key === "version") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: version must be a string.`,
        );
      }
      version = value;
      continue;
    }

    if (key === "releaseDate") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: releaseDate must be a string.`,
        );
      }
      releaseDate = value;
      continue;
    }

    if (key === "path" || key === "sha512") {
      continue;
    }

    extras[key] = value;
  }

  const finalized = parseFileRecord(currentFile, sourcePath, lines.length);
  if (finalized) files.push(finalized);

  if (!version) {
    throw new Error(`Invalid macOS update manifest at ${sourcePath}: missing version.`);
  }
  if (!releaseDate) {
    throw new Error(`Invalid macOS update manifest at ${sourcePath}: missing releaseDate.`);
  }
  if (files.length === 0) {
    throw new Error(`Invalid macOS update manifest at ${sourcePath}: missing files.`);
  }

  return {
    version,
    releaseDate,
    files,
    extras,
  };
}

function mergeExtras(
  primary: Readonly<Record<string, MacUpdateScalar>>,
  secondary: Readonly<Record<string, MacUpdateScalar>>,
): Record<string, MacUpdateScalar> {
  const merged: Record<string, MacUpdateScalar> = { ...primary };

  for (const [key, value] of Object.entries(secondary)) {
    const existing = merged[key];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Cannot merge macOS update manifests: conflicting '${key}' values ('${existing}' vs '${value}').`,
      );
    }
    merged[key] = value;
  }

  return merged;
}

export function mergeMacUpdateManifests(
  primary: MacUpdateManifest,
  secondary: MacUpdateManifest,
): MacUpdateManifest {
  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge macOS update manifests with different versions (${primary.version} vs ${secondary.version}).`,
    );
  }

  const filesByUrl = new Map<string, MacUpdateFile>();
  for (const file of [...primary.files, ...secondary.files]) {
    const existing = filesByUrl.get(file.url);
    if (existing && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
      throw new Error(
        `Cannot merge macOS update manifests: conflicting file entry for ${file.url}.`,
      );
    }
    filesByUrl.set(file.url, file);
  }

  return {
    version: primary.version,
    releaseDate:
      primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...filesByUrl.values()],
    extras: mergeExtras(primary.extras, secondary.extras),
  };
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function serializeScalarValue(value: MacUpdateScalar): string {
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return String(value);
}

export function serializeMacUpdateManifest(manifest: MacUpdateManifest): string {
  const lines = [`version: ${manifest.version}`, "files:"];

  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }

  for (const key of Object.keys(manifest.extras).toSorted()) {
    const value = manifest.extras[key];
    if (value === undefined) {
      throw new Error(`Cannot serialize macOS update manifest: missing value for '${key}'.`);
    }
    lines.push(`${key}: ${serializeScalarValue(value)}`);
  }

  lines.push(`releaseDate: ${quoteYamlString(manifest.releaseDate)}`);
  lines.push("");
  return lines.join("\n");
}

function main(args: ReadonlyArray<string>): void {
  const [arm64PathArg, x64PathArg, outputPathArg] = args;
  if (!arm64PathArg || !x64PathArg) {
    throw new Error(
      "Usage: node scripts/merge-mac-update-manifests.ts <latest-mac.yml> <latest-mac-x64.yml> [output-path]",
    );
  }

  const arm64Path = resolve(arm64PathArg);
  const x64Path = resolve(x64PathArg);
  const outputPath = resolve(outputPathArg ?? arm64PathArg);

  const arm64Manifest = parseMacUpdateManifest(readFileSync(arm64Path, "utf8"), arm64Path);
  const x64Manifest = parseMacUpdateManifest(readFileSync(x64Path, "utf8"), x64Path);
  const merged = mergeMacUpdateManifests(arm64Manifest, x64Manifest);
  writeFileSync(outputPath, serializeMacUpdateManifest(merged));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
