/**
 * Cross-region inference profile geo prefixes. A model id beginning with one
 * of these (e.g. `us.amazon.nova-micro-v1:0`) is a system-defined inference
 * profile id, not a foundation-model id.
 */
const INFERENCE_PROFILE_GEO_PREFIXES = new Set([
  "us",
  "us-gov",
  "eu",
  "apac",
  "jp",
  "au",
  "global",
]);

/**
 * Resolve the IAM policy `Resource` ARNs required to invoke a Bedrock model.
 *
 * Accepts any of the model reference forms `Converse`/`InvokeModel` accept:
 *
 * - a foundation-model id (`anthropic.claude-sonnet-4-20250514-v1:0`) —
 *   resolves to `arn:aws:bedrock:{region}::foundation-model/{modelId}`
 * - a cross-region inference profile id (`us.amazon.nova-micro-v1:0`) —
 *   resolves to the account's inference-profile ARN *plus* the underlying
 *   foundation-model ARN in every region the profile can route to
 *   (`arn:aws:bedrock:*::foundation-model/{baseModelId}`), which Bedrock
 *   requires for cross-region invocation
 * - a full ARN (foundation model, inference profile, application inference
 *   profile, imported/custom model, or prompt ARN) — passed through as-is
 */
export const bedrockModelArns = (
  region: string,
  accountId: string,
  modelId: string,
): string[] => {
  if (modelId.startsWith("arn:")) {
    return [modelId];
  }
  const geoPrefix = modelId.split(".", 1)[0];
  if (geoPrefix && INFERENCE_PROFILE_GEO_PREFIXES.has(geoPrefix)) {
    return [
      `arn:aws:bedrock:${region}:${accountId}:inference-profile/${modelId}`,
      `arn:aws:bedrock:*::foundation-model/${modelId.slice(geoPrefix.length + 1)}`,
    ];
  }
  return [`arn:aws:bedrock:${region}::foundation-model/${modelId}`];
};
