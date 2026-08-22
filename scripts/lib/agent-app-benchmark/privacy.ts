import * as Schema from "effect/Schema";

import { Sha256 } from "./contracts.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ShareableLocalCorpusSummary = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.Literal("local-opencode-aggregate"),
  selectedSessionCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  partCount: NonNegativeInt,
  eventCount: NonNegativeInt,
  finalRenderableBytes: NonNegativeInt,
  eventBytes: NonNegativeInt,
  sizeDistributionBytes: Schema.Struct({
    minimum: NonNegativeInt,
    median: NonNegativeInt,
    maximum: NonNegativeInt,
  }),
  semanticSha256: Sha256,
});
export type ShareableLocalCorpusSummary = typeof ShareableLocalCorpusSummary.Type;

export interface LocalCorpusAggregateInput {
  readonly selectedSessionCount: number;
  readonly messageCount: number;
  readonly partCount: number;
  readonly eventCount: number;
  readonly finalRenderableBytes: number;
  readonly eventBytes: number;
  readonly sizeDistributionBytes: {
    readonly minimum: number;
    readonly median: number;
    readonly maximum: number;
  };
  readonly semanticSha256: string;
  // Callers normally hold these private fields beside the aggregate values.
  // They are accepted only to make the allowlist boundary explicit and are never projected.
  readonly sourceDatabasePath?: string;
  readonly selectedSourceIds?: ReadonlyArray<string>;
  readonly transcriptSample?: string;
  readonly authRows?: ReadonlyArray<unknown>;
}

const decodeSummary = Schema.decodeUnknownSync(ShareableLocalCorpusSummary);

export function buildShareableLocalCorpusSummary(
  input: LocalCorpusAggregateInput,
): ShareableLocalCorpusSummary {
  return decodeSummary({
    schemaVersion: 1,
    source: "local-opencode-aggregate",
    selectedSessionCount: input.selectedSessionCount,
    messageCount: input.messageCount,
    partCount: input.partCount,
    eventCount: input.eventCount,
    finalRenderableBytes: input.finalRenderableBytes,
    eventBytes: input.eventBytes,
    sizeDistributionBytes: input.sizeDistributionBytes,
    semanticSha256: input.semanticSha256,
  });
}

export interface PrivacyFinding {
  readonly code: "sensitive-key" | "credential" | "absolute-path" | "url" | "forbidden-phrase";
  readonly path: string;
}

const SENSITIVE_KEY =
  /(?:^|_)(?:access.?token|refresh.?token|authorization|credential|secret|prompt|transcript|content|text|title|path|url|href|tool.?args?|input|output|attachment)(?:$|_)/iu;

/**
 * The term boundaries above are underscore/edge anchored, but every artifact
 * in this repo is camelCase, so `promptText` and `filePath` would otherwise
 * slip past. Normalizing to snake_case first applies one term list to both
 * spellings.
 */
function normalizeKey(key: string): string {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replaceAll(/[^A-Za-z0-9]+/gu, "_");
}
const CREDENTIAL =
  /(?:\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,})/u;
const ABSOLUTE_PATH =
  /(?:^|[\s"'])(?:\/(?:Users|home|private|tmp|var|Volumes)\/[^\s"']+|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"']+)/u;
const URL = /\b(?:https?|file):\/\/[^\s"']+/iu;

export function scanShareableArtifact(
  value: unknown,
  options: { readonly forbiddenPhrases?: ReadonlyArray<string> } = {},
): ReadonlyArray<PrivacyFinding> {
  const findings: Array<PrivacyFinding> = [];
  const forbidden = (options.forbiddenPhrases ?? []).filter((phrase) => phrase.length > 0);

  const scan = (entry: unknown, path: string): void => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => scan(item, `${path}[${index}]`));
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
        if (SENSITIVE_KEY.test(normalizeKey(key))) {
          findings.push({ code: "sensitive-key", path: childPath });
        }
        scan(child, childPath);
      }
      return;
    }
    if (typeof entry !== "string") return;
    if (CREDENTIAL.test(entry)) findings.push({ code: "credential", path });
    if (ABSOLUTE_PATH.test(entry)) findings.push({ code: "absolute-path", path });
    if (URL.test(entry)) findings.push({ code: "url", path });
    const lower = entry.toLocaleLowerCase();
    if (forbidden.some((phrase) => lower.includes(phrase.toLocaleLowerCase()))) {
      findings.push({ code: "forbidden-phrase", path });
    }
  };

  scan(value, "$");
  return findings;
}

export function assertShareableArtifact(
  value: unknown,
  options?: { readonly forbiddenPhrases?: ReadonlyArray<string> },
): void {
  const findings = scanShareableArtifact(value, options);
  if (findings.length > 0) {
    throw new Error(
      `Shareable artifact failed privacy scan (${findings.map((finding) => finding.code).join(", ")}).`,
    );
  }
}
