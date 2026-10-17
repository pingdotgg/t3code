import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const BUILD_VALIDATION_POLICY_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";

const decodeEvaluations = decodeJsonResult(
  Schema.Array(
    Schema.Struct({
      status: Schema.String,
      configuration: Schema.Struct({
        id: Schema.Int,
        isEnabled: Schema.Boolean,
        isBlocking: Schema.Boolean,
        isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
        type: Schema.Struct({ id: Schema.String }),
        settings: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ displayName: Schema.optional(Schema.NullOr(Schema.String)) }),
          ),
        ),
      }),
    }),
  ),
);

function checkStatus(status: string): PullRequestCheckStatus {
  switch (status.toLowerCase()) {
    case "approved":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    default:
      // Queued, running, and unknown states cannot establish that validation passed.
      return "pending";
  }
}

/**
 * PR policy evaluations describe the current validation, including expired or requeued builds.
 * Build history and PR statuses alone cannot establish whether a required build is still valid.
 * Reject malformed pages whole: dropping a required check could falsely report completion.
 */
export function decodeBuildPolicyChecksJson(raw: string) {
  const decoded = decodeEvaluations(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const checks: PullRequestCheck[] = [];
  for (const { configuration, status } of decoded.success) {
    if (
      configuration.type.id.toLowerCase() !== BUILD_VALIDATION_POLICY_TYPE ||
      !configuration.isEnabled ||
      configuration.isDeleted ||
      status.toLowerCase() === "notapplicable"
    ) {
      continue;
    }
    const label = configuration.settings?.displayName?.trim() || "Build validation";
    checks.push({
      // Policy identity survives reruns and distinguishes builds with the same display name.
      name: `${label} (#${configuration.id})`,
      status: checkStatus(status),
      required: configuration.isBlocking,
      description: null,
      url: null,
    });
  }
  return Result.succeed({ checks, rawCount: decoded.success.length });
}
