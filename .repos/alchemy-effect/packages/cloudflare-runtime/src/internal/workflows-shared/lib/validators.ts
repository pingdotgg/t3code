// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Alchemy modifications: uses Effect Schema instead of Zod, preserves strict excess-property validation, and supports function retry delays.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ms } from "itty-time";

export const SENSITIVE_STEP_OUTPUT = "output";

export const MAX_WORKFLOW_NAME_LENGTH = 64;

export const MAX_WORKFLOW_INSTANCE_ID_LENGTH = 100;

export const MAX_ADDRESSABLE_WORKFLOW_INSTANCE_ID_LENGTH = 271;

export const MAX_STEP_NAME_LENGTH = 256;

export const ALLOWED_STRING_ID_PATTERN = "^[a-zA-Z0-9_][a-zA-Z0-9-_]*$";
export const ALLOWED_ADDRESSABLE_WORKFLOW_INSTANCE_ID_PATTERN =
  "^[a-zA-Z0-9, */#_-]+$";
const ALLOWED_WORKFLOW_INSTANCE_ID_REGEX = new RegExp(ALLOWED_STRING_ID_PATTERN);
const ALLOWED_ADDRESSABLE_WORKFLOW_INSTANCE_ID_REGEX = new RegExp(
  ALLOWED_ADDRESSABLE_WORKFLOW_INSTANCE_ID_PATTERN,
);
const ALLOWED_WORKFLOW_NAME_REGEX = ALLOWED_WORKFLOW_INSTANCE_ID_REGEX;

// eslint-disable-next-line no-control-regex -- intentional use of control character range to detect invalid characters in workflow names
const CONTROL_CHAR_REGEX = new RegExp("[\x00-\x1F]");

export function isValidWorkflowName(name: string): boolean {
  if (typeof name !== "string") {
    return false;
  }
  if (name.length > MAX_WORKFLOW_NAME_LENGTH) {
    return false;
  }

  return ALLOWED_WORKFLOW_NAME_REGEX.test(name);
}

export function isValidWorkflowInstanceId(id: string): boolean {
  if (typeof id !== "string") {
    return false;
  }

  if (id.length > MAX_WORKFLOW_INSTANCE_ID_LENGTH) {
    return false;
  }

  return ALLOWED_WORKFLOW_INSTANCE_ID_REGEX.test(id);
}

/** Validates IDs that address existing instances, including generated cron IDs. */
export function isValidAddressableWorkflowInstanceId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_ADDRESSABLE_WORKFLOW_INSTANCE_ID_LENGTH &&
    ALLOWED_ADDRESSABLE_WORKFLOW_INSTANCE_ID_REGEX.test(id)
  );
}

export function isValidStepName(name: string): boolean {
  if (name.length > MAX_STEP_NAME_LENGTH) {
    return false;
  }

  return !CONTROL_CHAR_REGEX.test(name);
}

const NonNegativeNumberOrString = Schema.Union([
  Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.String,
]);

const STEP_CONFIG_SCHEMA = Schema.Struct({
  retries: Schema.optional(
    Schema.Struct({
      delay: Schema.Unknown,
      limit: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
      backoff: Schema.optional(Schema.Literals(["constant", "linear", "exponential"])),
    }),
  ),
  timeout: Schema.optional(NonNegativeNumberOrString),
  sensitive: Schema.optional(Schema.Literal(SENSITIVE_STEP_OUTPUT)),
});

const decodeStepConfig = Schema.decodeUnknownResult(STEP_CONFIG_SCHEMA);

export function isValidStepConfig(stepConfig: unknown): boolean {
  const config = decodeStepConfig(stepConfig, { onExcessProperty: "error" });

  if (Result.isFailure(config)) {
    return false;
  }

  const data = config.success;

  if (data.retries !== undefined) {
    const delay = data.retries.delay;
    if (
      !(
        typeof delay === "function" ||
        typeof delay === "string" ||
        (typeof delay === "number" && delay >= 0)
      ) ||
      (typeof delay !== "function" && Number.isNaN(ms(delay)))
    ) {
      return false;
    }
  }

  if (data.timeout !== undefined) {
    const timeout = data.timeout;
    if (timeout == 0 || Number.isNaN(ms(timeout))) {
      return false;
    }
  }

  return true;
}
