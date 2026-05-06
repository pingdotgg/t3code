import { AI_LOOP_SCHEMA_VERSION, type AiLoopPrMetadata } from "./schema";

export const AI_LOOP_PR_METADATA_MARKER = "ai-loop-pr-metadata-v1";

const PR_METADATA_REGEX = new RegExp(
  `<!--\\s*${AI_LOOP_PR_METADATA_MARKER}\\s*([\\s\\S]*?)\\s*-->`,
  "m",
);

const assertRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PR metadata payload must be an object.");
  }

  return value as Record<string, unknown>;
};

export const createDefaultPrMetadata = (): AiLoopPrMetadata => ({
  schema_version: AI_LOOP_SCHEMA_VERSION,
  owner: "unset",
  enabled: false,
  mode: "same-branch",
  human_comments_policy: "pr-author-only",
});

export const parseAiLoopPrMetadata = (body: string): AiLoopPrMetadata => {
  const match = body.match(PR_METADATA_REGEX);
  if (!match?.[1]) {
    return createDefaultPrMetadata();
  }

  let record: Record<string, unknown>;
  try {
    record = assertRecord(JSON.parse(match[1]) as unknown);
  } catch {
    return createDefaultPrMetadata();
  }

  const owner = typeof record.owner === "string" ? record.owner : "unset";
  const enabled = record.enabled === true;

  return {
    schema_version:
      typeof record.schema_version === "number" ? record.schema_version : AI_LOOP_SCHEMA_VERSION,
    owner,
    enabled,
    mode: "same-branch",
    human_comments_policy: "pr-author-only",
  };
};

export const renderAiLoopPrMetadata = (metadata: AiLoopPrMetadata): string =>
  `<!-- ${AI_LOOP_PR_METADATA_MARKER}\n${JSON.stringify(metadata, null, 2)}\n-->`;
