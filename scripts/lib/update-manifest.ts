import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";

export interface UpdateManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export const UpdateManifestScalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type UpdateManifestScalar = typeof UpdateManifestScalar.Type;

export const UpdateManifestScalarType = Schema.Literals(["string", "number", "boolean"]);
export type UpdateManifestScalarType = typeof UpdateManifestScalarType.Type;

export const UpdateManifestParseReason = Schema.Literals([
  "incomplete file entry",
  "sha512 without a file entry",
  "size without a file entry",
  "unsupported line",
  "version must be a string",
  "releaseDate must be a string",
  "missing version",
  "missing releaseDate",
  "missing files",
]);
export type UpdateManifestParseReason = typeof UpdateManifestParseReason.Type;

export class UpdateManifestParseError extends Schema.TaggedErrorClass<UpdateManifestParseError>()(
  "UpdateManifestParseError",
  {
    platformLabel: Schema.String,
    sourcePath: Schema.String,
    lineNumber: Schema.optionalKey(Schema.Number),
    reason: UpdateManifestParseReason,
    lineLength: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    const location =
      this.lineNumber === undefined ? this.sourcePath : `${this.sourcePath}:${this.lineNumber}`;
    const input = this.lineLength === undefined ? "" : ` Input length: ${this.lineLength}.`;
    return `Invalid ${this.platformLabel} update manifest at ${location}: ${this.reason}.${input}`;
  }
}

export class UpdateManifestVersionConflictError extends Schema.TaggedErrorClass<UpdateManifestVersionConflictError>()(
  "UpdateManifestVersionConflictError",
  {
    platformLabel: Schema.String,
    primaryVersion: Schema.String,
    secondaryVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot merge ${this.platformLabel} update manifests with different versions (${this.primaryVersion} vs ${this.secondaryVersion}).`;
  }
}

export class UpdateManifestExtraConflictError extends Schema.TaggedErrorClass<UpdateManifestExtraConflictError>()(
  "UpdateManifestExtraConflictError",
  {
    platformLabel: Schema.String,
    key: Schema.String,
    primaryValueType: UpdateManifestScalarType,
    primaryValueLength: Schema.optionalKey(Schema.Number),
    secondaryValueType: UpdateManifestScalarType,
    secondaryValueLength: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return `Cannot merge ${this.platformLabel} update manifests: conflicting '${this.key}' ${this.primaryValueType} and ${this.secondaryValueType} values.`;
  }
}

export class UpdateManifestFileConflictError extends Schema.TaggedErrorClass<UpdateManifestFileConflictError>()(
  "UpdateManifestFileConflictError",
  {
    platformLabel: Schema.String,
    urlInputLength: Schema.Number,
    urlProtocol: Schema.optionalKey(Schema.String),
    urlHostname: Schema.optionalKey(Schema.String),
    existingManifest: Schema.Literals(["primary", "secondary"]),
    existingSha512Length: Schema.Number,
    existingSize: Schema.Number,
    conflictingManifest: Schema.Literals(["primary", "secondary"]),
    conflictingSha512Length: Schema.Number,
    conflictingSize: Schema.Number,
    sha512Conflict: Schema.Boolean,
    sizeConflict: Schema.Boolean,
  },
) {
  override get message(): string {
    const origin =
      this.urlProtocol === undefined || this.urlHostname === undefined
        ? ""
        : ` at ${this.urlProtocol}//${this.urlHostname}`;
    return `Cannot merge ${this.platformLabel} update manifests: conflicting file entry${origin} (URL input length: ${this.urlInputLength}).`;
  }
}

export class UpdateManifestSerializationError extends Schema.TaggedErrorClass<UpdateManifestSerializationError>()(
  "UpdateManifestSerializationError",
  {
    platformLabel: Schema.String,
    key: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot serialize ${this.platformLabel} update manifest: missing value for '${this.key}'.`;
  }
}

export const UpdateManifestError = Schema.Union([
  UpdateManifestParseError,
  UpdateManifestVersionConflictError,
  UpdateManifestExtraConflictError,
  UpdateManifestFileConflictError,
  UpdateManifestSerializationError,
]);
export type UpdateManifestError = typeof UpdateManifestError.Type;
export const isUpdateManifestError = Schema.is(UpdateManifestError);

export const attemptUpdateManifest = <A>(
  evaluate: () => A,
): Effect.Effect<A, UpdateManifestError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(evaluate());
    } catch (error) {
      return isUpdateManifestError(error) ? Effect.fail(error) : Effect.die(error);
    }
  });

export interface UpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<UpdateManifestFile>;
  readonly extras: Readonly<Record<string, UpdateManifestScalar>>;
}

interface MutableUpdateManifestFile {
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
  currentFile: MutableUpdateManifestFile | null,
  sourcePath: string,
  lineNumber: number,
  platformLabel: string,
): UpdateManifestFile | null {
  if (currentFile === null) {
    return null;
  }
  if (
    typeof currentFile.url !== "string" ||
    typeof currentFile.sha512 !== "string" ||
    typeof currentFile.size !== "number"
  ) {
    throw new UpdateManifestParseError({
      platformLabel,
      sourcePath,
      lineNumber,
      reason: "incomplete file entry",
    });
  }
  return {
    url: currentFile.url,
    sha512: currentFile.sha512,
    size: currentFile.size,
  };
}

function parseScalarValue(rawValue: string): UpdateManifestScalar {
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

export function parseUpdateManifest(
  raw: string,
  sourcePath: string,
  platformLabel: string,
): UpdateManifest {
  const lines = raw.split(/\r?\n/);
  const files: UpdateManifestFile[] = [];
  const extras: Record<string, UpdateManifestScalar> = {};
  let version: string | null = null;
  let releaseDate: string | null = null;
  let inFiles = false;
  let currentFile: MutableUpdateManifestFile | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/);
    if (fileUrlMatch?.[1]) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber, platformLabel);
      if (finalized) files.push(finalized);
      currentFile = { url: stripSingleQuotes(fileUrlMatch[1].trim()) };
      inFiles = true;
      continue;
    }

    const fileShaMatch = line.match(/^    sha512:\s*(.+)$/);
    if (fileShaMatch?.[1]) {
      if (currentFile === null) {
        throw new UpdateManifestParseError({
          platformLabel,
          sourcePath,
          lineNumber,
          reason: "sha512 without a file entry",
        });
      }
      currentFile.sha512 = stripSingleQuotes(fileShaMatch[1].trim());
      continue;
    }

    const fileSizeMatch = line.match(/^    size:\s*(\d+)$/);
    if (fileSizeMatch?.[1]) {
      if (currentFile === null) {
        throw new UpdateManifestParseError({
          platformLabel,
          sourcePath,
          lineNumber,
          reason: "size without a file entry",
        });
      }
      currentFile.size = Number(fileSizeMatch[1]);
      continue;
    }

    if (line === "files:") {
      inFiles = true;
      continue;
    }

    if (inFiles && currentFile !== null) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber, platformLabel);
      if (finalized) files.push(finalized);
      currentFile = null;
    }
    inFiles = false;

    const topLevelMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!topLevelMatch?.[1] || topLevelMatch[2] === undefined) {
      throw new UpdateManifestParseError({
        platformLabel,
        sourcePath,
        lineNumber,
        reason: "unsupported line",
        lineLength: line.length,
      });
    }

    const [, key, rawValue] = topLevelMatch;
    const value = parseScalarValue(rawValue);

    if (key === "version") {
      if (typeof value !== "string") {
        throw new UpdateManifestParseError({
          platformLabel,
          sourcePath,
          lineNumber,
          reason: "version must be a string",
        });
      }
      version = value;
      continue;
    }

    if (key === "releaseDate") {
      if (typeof value !== "string") {
        throw new UpdateManifestParseError({
          platformLabel,
          sourcePath,
          lineNumber,
          reason: "releaseDate must be a string",
        });
      }
      releaseDate = value;
      continue;
    }

    if (key === "path" || key === "sha512") {
      continue;
    }

    extras[key] = value;
  }

  const finalized = parseFileRecord(currentFile, sourcePath, lines.length, platformLabel);
  if (finalized) files.push(finalized);

  if (!version) {
    throw new UpdateManifestParseError({
      platformLabel,
      sourcePath,
      reason: "missing version",
    });
  }
  if (!releaseDate) {
    throw new UpdateManifestParseError({
      platformLabel,
      sourcePath,
      reason: "missing releaseDate",
    });
  }
  if (files.length === 0) {
    throw new UpdateManifestParseError({
      platformLabel,
      sourcePath,
      reason: "missing files",
    });
  }

  return {
    version,
    releaseDate,
    files,
    extras,
  };
}

function getScalarType(value: UpdateManifestScalar): UpdateManifestScalarType {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function mergeExtras(
  primary: Readonly<Record<string, UpdateManifestScalar>>,
  secondary: Readonly<Record<string, UpdateManifestScalar>>,
  platformLabel: string,
): Record<string, UpdateManifestScalar> {
  const merged: Record<string, UpdateManifestScalar> = { ...primary };

  for (const [key, value] of Object.entries(secondary)) {
    const existing = merged[key];
    if (existing !== undefined && existing !== value) {
      throw new UpdateManifestExtraConflictError({
        platformLabel,
        key,
        primaryValueType: getScalarType(existing),
        ...(typeof existing === "string" ? { primaryValueLength: existing.length } : {}),
        secondaryValueType: getScalarType(value),
        ...(typeof value === "string" ? { secondaryValueLength: value.length } : {}),
      });
    }
    merged[key] = value;
  }

  return merged;
}

export function mergeUpdateManifests(
  primary: UpdateManifest,
  secondary: UpdateManifest,
  platformLabel: string,
): UpdateManifest {
  if (primary.version !== secondary.version) {
    throw new UpdateManifestVersionConflictError({
      platformLabel,
      primaryVersion: primary.version,
      secondaryVersion: secondary.version,
    });
  }

  const filesByUrl = new Map<
    string,
    { readonly manifest: "primary" | "secondary"; readonly file: UpdateManifestFile }
  >();
  for (const [manifest, files] of [
    ["primary", primary.files],
    ["secondary", secondary.files],
  ] as const) {
    for (const file of files) {
      const existing = filesByUrl.get(file.url);
      if (existing && (existing.file.sha512 !== file.sha512 || existing.file.size !== file.size)) {
        const urlDiagnostics = getUrlDiagnostics(file.url);
        throw new UpdateManifestFileConflictError({
          platformLabel,
          urlInputLength: urlDiagnostics.inputLength,
          ...(urlDiagnostics.protocol === undefined
            ? {}
            : { urlProtocol: urlDiagnostics.protocol }),
          ...(urlDiagnostics.hostname === undefined
            ? {}
            : { urlHostname: urlDiagnostics.hostname }),
          existingManifest: existing.manifest,
          existingSha512Length: existing.file.sha512.length,
          existingSize: existing.file.size,
          conflictingManifest: manifest,
          conflictingSha512Length: file.sha512.length,
          conflictingSize: file.size,
          sha512Conflict: existing.file.sha512 !== file.sha512,
          sizeConflict: existing.file.size !== file.size,
        });
      }
      filesByUrl.set(file.url, { manifest, file });
    }
  }

  return {
    version: primary.version,
    releaseDate:
      primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...filesByUrl.values()].map(({ file }) => file),
    extras: mergeExtras(primary.extras, secondary.extras, platformLabel),
  };
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function serializeScalarValue(value: UpdateManifestScalar): string {
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return String(value);
}

export function serializeUpdateManifest(
  manifest: UpdateManifest,
  options: {
    readonly platformLabel: string;
  },
): string {
  const lines = [`version: ${quoteYamlString(manifest.version)}`, "files:"];

  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }

  for (const key of Object.keys(manifest.extras).toSorted()) {
    const value = manifest.extras[key];
    if (value === undefined) {
      throw new UpdateManifestSerializationError({
        platformLabel: options.platformLabel,
        key,
      });
    }
    lines.push(`${key}: ${serializeScalarValue(value)}`);
  }

  lines.push(`releaseDate: ${quoteYamlString(manifest.releaseDate)}`);
  lines.push("");
  return lines.join("\n");
}
