/**
 * Local Flagship flag evaluation, following the documented semantics of the
 * Cloudflare Flagship binding:
 *
 * - https://developers.cloudflare.com/flagship/targeting/
 * - https://developers.cloudflare.com/flagship/targeting/operators/
 * - https://developers.cloudflare.com/flagship/targeting/percentage-rollouts/
 * - https://developers.cloudflare.com/flagship/reference/evaluation-reasons/
 *
 * Rollout bucketing uses a stable hash of the flag key and the bucketing
 * value. Cloudflare doesn't document its hash, so a given user can land in a
 * different bucket locally than in production; the split ratios and
 * stickiness are the same.
 */
import type {
  FlagshipCondition,
  FlagshipFlagDefinition,
  FlagshipRule,
} from "./FlagshipOptions.shared.ts";

/** The value type a typed evaluation method expects. */
export type FlagshipValueType = "boolean" | "string" | "number" | "object";

export interface FlagshipDetails {
  flagKey: string;
  value: unknown;
  variant?: string;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Context paths and condition groups nest at most five levels deep. */
const MAX_DEPTH = 5;

export const evaluateFlag = (input: {
  readonly flagKey: string;
  readonly flag: FlagshipFlagDefinition | undefined;
  readonly defaultValue: unknown;
  readonly expectedType: FlagshipValueType | undefined;
  readonly context: unknown;
}): FlagshipDetails => {
  const { flagKey, flag, defaultValue, expectedType } = input;
  const error = (errorCode: string, errorMessage: string): FlagshipDetails => ({
    flagKey,
    value: defaultValue,
    reason: "ERROR",
    errorCode,
    errorMessage,
  });

  const context = normalizeContext(input.context);
  if (!context.ok) return error("INVALID_CONTEXT", context.message);
  if (flag === undefined) {
    return error("FLAG_NOT_FOUND", `Flag "${flagKey}" not found`);
  }

  const resolved = resolveVariant(flagKey, flag, context.value);
  if (!(resolved.variant in flag.variations)) {
    return error("GENERAL", `Flag "${flagKey}" has no variation "${resolved.variant}"`);
  }
  const value = flag.variations[resolved.variant];
  if (expectedType !== undefined && !isOfType(value, expectedType)) {
    return {
      flagKey,
      value: defaultValue,
      variant: resolved.variant,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
      errorMessage: `Flag "${flagKey}" is not a ${expectedType} flag`,
    };
  }
  return { flagKey, value, variant: resolved.variant, reason: resolved.reason };
};

const resolveVariant = (
  flagKey: string,
  flag: FlagshipFlagDefinition,
  context: Record<string, unknown>,
): { variant: string; reason: string } => {
  if (!flag.enabled) return { variant: flag.defaultVariation, reason: "DISABLED" };
  if (flag.rules.length === 0) return { variant: flag.defaultVariation, reason: "STATIC" };
  const rules = [...flag.rules].sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    if (!rule.conditions.every((condition) => matchCondition(condition, context, 1))) continue;
    if (rule.rollout === undefined) {
      return { variant: rule.serveVariation, reason: "TARGETING_MATCH" };
    }
    if (inRollout(flagKey, rule.rollout, context)) {
      return { variant: rule.serveVariation, reason: "SPLIT" };
    }
  }
  return { variant: flag.defaultVariation, reason: "DEFAULT" };
};

const matchCondition = (
  condition: FlagshipCondition,
  context: Record<string, unknown>,
  depth: number,
): boolean => {
  if ("clauses" in condition) {
    if (depth > MAX_DEPTH) return false;
    const match = (clause: FlagshipCondition) => matchCondition(clause, context, depth + 1);
    return condition.logicalOperator === "OR"
      ? condition.clauses.some(match)
      : condition.clauses.every(match);
  }
  const attribute = resolvePath(context, condition.attribute);
  // Missing attributes never match, including with negative operators.
  if (!attribute.found) return false;
  return compare(condition.operator, attribute.value, condition.value);
};

const compare = (operator: string, attribute: unknown, value: unknown): boolean => {
  // A `null` attribute only matches `not_equals` and `not_in`.
  if (attribute === null) return operator === "not_equals" || operator === "not_in";
  if (Array.isArray(attribute)) {
    switch (operator) {
      case "has":
        return attribute.some((item) => item === value);
      case "not_has":
        return !attribute.some((item) => item === value);
      default:
        return false;
    }
  }
  // Objects never act as scalar operands.
  if (typeof attribute === "object") return false;
  switch (operator) {
    case "equals":
      return attribute === value;
    case "not_equals":
      return attribute !== value;
    case "greater_than":
      return order(attribute, value, (d) => d > 0);
    case "less_than":
      return order(attribute, value, (d) => d < 0);
    case "greater_than_or_equals":
      return order(attribute, value, (d) => d >= 0);
    case "less_than_or_equals":
      return order(attribute, value, (d) => d <= 0);
    case "contains":
      return (
        typeof attribute === "string" && typeof value === "string" && attribute.includes(value)
      );
    case "starts_with":
      return (
        typeof attribute === "string" && typeof value === "string" && attribute.startsWith(value)
      );
    case "ends_with":
      return (
        typeof attribute === "string" && typeof value === "string" && attribute.endsWith(value)
      );
    case "in":
      return Array.isArray(value) && value.some((item) => item === attribute);
    case "not_in":
      return Array.isArray(value) && !value.some((item) => item === attribute);
    default:
      return false;
  }
};

/**
 * Order two operands: numbers numerically, ISO 8601 datetime strings by
 * timestamp. Any other pairing doesn't match.
 */
const order = (attribute: unknown, value: unknown, test: (difference: number) => boolean) => {
  if (typeof attribute === "number" && typeof value === "number") {
    return test(attribute - value);
  }
  if (typeof attribute === "string" && typeof value === "string") {
    const a = Date.parse(attribute);
    const b = Date.parse(value);
    return !Number.isNaN(a) && !Number.isNaN(b) && test(a - b);
  }
  return false;
};

const inRollout = (
  flagKey: string,
  rollout: NonNullable<FlagshipRule["rollout"]>,
  context: Record<string, unknown>,
): boolean => {
  const { percentage, attribute = "targetingKey" } = rollout;
  const resolved = resolvePath(context, attribute);
  let bucket: number;
  if (!resolved.found || resolved.value === null) {
    // No bucketing value: a random bucket per evaluation.
    bucket = Math.random() * 100;
  } else if (typeof resolved.value === "object") {
    // An array or object bucketing value fails the rule.
    return false;
  } else {
    // A validated context only holds JSON scalars here.
    const value = resolved.value as string | number | boolean;
    bucket =
      fnv1a(`${flagKey}\u0000${typeof value === "string" ? value : JSON.stringify(value)}`) % 100;
  }
  return bucket < percentage;
};

/** 32-bit FNV-1a over the UTF-16 code units of `input`. */
const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * Resolve an attribute from the context. A literal top-level key wins over
 * dot-separated traversal, which can cross at most five segments.
 */
const resolvePath = (
  context: Record<string, unknown>,
  path: string,
): { found: false } | { found: true; value: unknown } => {
  if (Object.hasOwn(context, path)) return { found: true, value: context[path] };
  const segments = path.split(".");
  if (segments.length > MAX_DEPTH) return { found: false };
  let current: unknown = context;
  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
};

const isOfType = (value: unknown, type: FlagshipValueType): boolean =>
  type === "object" ? value !== null && typeof value === "object" : typeof value === type;

/**
 * Validate the evaluation context and normalize `Date` values to ISO 8601
 * strings. Numbers must be finite; cycles and non-plain objects are
 * rejected.
 */
const normalizeContext = (
  context: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } => {
  if (context === undefined || context === null) return { ok: true, value: {} };
  if (typeof context !== "object" || Array.isArray(context)) {
    return { ok: false, message: "Evaluation context must be an object" };
  }
  const seen = new Set<object>();
  let failure: string | undefined;
  const fail = (message: string) => {
    failure ??= message;
    return undefined;
  };
  const visit = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fail(`${path} is not a finite number`);
    }
    if (isDate(value)) {
      return Number.isNaN(value.getTime())
        ? fail(`${path} is an invalid date`)
        : value.toISOString();
    }
    if (typeof value !== "object") return fail(`${path} has an unsupported type (${typeof value})`);
    if (seen.has(value)) return fail(`${path} contains a cycle`);
    seen.add(value);
    let out: unknown;
    if (Array.isArray(value)) {
      out = value.map((item, i) => visit(item, `${path}[${i}]`));
    } else {
      const proto = Object.getPrototypeOf(value);
      out =
        proto !== Object.prototype && proto !== null
          ? fail(`${path} is not a plain object`)
          : Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, visit(item, `${path}.${key}`)]),
            );
    }
    seen.delete(value);
    return out;
  };
  const value = visit(context, "context") as Record<string, unknown>;
  return failure === undefined ? { ok: true, value } : { ok: false, message: failure };
};

const isDate = (value: unknown): value is Date =>
  Object.prototype.toString.call(value) === "[object Date]";
