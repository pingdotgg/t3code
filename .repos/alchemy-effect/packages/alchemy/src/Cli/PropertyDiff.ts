import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { havePropsChanged } from "../Diff.ts";
import * as Output from "../Output.ts";
import { isPlainData } from "../Util/data.ts";
import { stringify } from "yaml";

export type YamlDisplayValue =
  | string
  | number
  | boolean
  | null
  | YamlDisplayValue[]
  | { readonly [key: string]: YamlDisplayValue };

export interface DeclaredPropertyYaml {
  readonly kind: "create" | "change" | "drift";
  readonly lines: ReadonlyArray<string>;
}

const unifiedDriftLines = (
  expected: YamlDisplayValue,
  actual: YamlDisplayValue,
  depth = 0,
): string[] => {
  const padding = " ".repeat(depth);
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return indent(formatYamlLines(expected), depth);
  }
  if (
    expected !== null &&
    actual !== null &&
    !Array.isArray(expected) &&
    !Array.isArray(actual) &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    const lines: string[] = [];
    for (const key of [
      ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
    ].sort((a, b) => a.localeCompare(b))) {
      const hasExpected = Object.hasOwn(expected, key);
      const hasActual = Object.hasOwn(actual, key);
      const expectedValue = hasExpected ? expected[key]! : UNDEFINED;
      const actualValue = hasActual ? actual[key]! : UNDEFINED;
      if (
        hasExpected &&
        hasActual &&
        expectedValue !== null &&
        actualValue !== null &&
        !Array.isArray(expectedValue) &&
        !Array.isArray(actualValue) &&
        typeof expectedValue === "object" &&
        typeof actualValue === "object" &&
        JSON.stringify(expectedValue) !== JSON.stringify(actualValue)
      ) {
        lines.push(`${padding}${key}:`);
        lines.push(...unifiedDriftLines(expectedValue, actualValue, depth + 2));
      } else if (
        JSON.stringify(expectedValue) === JSON.stringify(actualValue)
      ) {
        lines.push(...indent(formatYamlLines({ [key]: expectedValue }), depth));
      } else {
        if (hasExpected) {
          lines.push(
            ...indent(formatYamlLines({ [key]: expectedValue }), depth).map(
              mark("-"),
            ),
          );
        }
        if (hasActual) {
          lines.push(
            ...indent(formatYamlLines({ [key]: actualValue }), depth).map(
              mark("+"),
            ),
          );
        }
      }
    }
    return lines;
  }
  return [
    ...indent(formatYamlLines(expected), depth).map(mark("-")),
    ...indent(formatYamlLines(actual), depth).map(mark("+")),
  ];
};

const mark = (marker: "-" | "+") => (line: string) => {
  return `${marker} ${line}`;
};

export interface YamlChangeMatch {
  readonly marker: "-" | "+";
  readonly content: string;
}

/** Match a `- `/`+ ` change marker emitted by {@link unifiedDriftLines}. */
export const matchYamlChange = (line: string): YamlChangeMatch | undefined => {
  const match = line.match(/^([+-]) (.*)$/);
  return match === null
    ? undefined
    : { marker: match[1] as "-" | "+", content: match[2]! };
};

export interface YamlKeyMatch {
  readonly indent: string;
  /** The key including its trailing colon. */
  readonly key: string;
  readonly value: string;
}

/** Match an `indent` + `key:` + rest display-YAML line for colorizing. */
export const matchYamlKey = (line: string): YamlKeyMatch | undefined => {
  const match = line.match(/^(\s*)([A-Za-z_][\w .-]*:)(.*)$/);
  return match === null
    ? undefined
    : { indent: match[1]!, key: match[2]!, value: match[3]! };
};

/** Format the changed cloud attributes carried by a drift-repair plan. */
export const formatDriftPropertyYaml = (
  expected: unknown,
  actual: unknown,
  missing = false,
): DeclaredPropertyYaml => {
  const expectedValue = toYamlDisplayValue(expected);
  const actualValue = missing ? "(missing)" : toYamlDisplayValue(actual);
  return {
    kind: "drift",
    lines: unifiedDriftLines(expectedValue, actualValue),
  };
};

const REDACTED = "(redacted)";
const KNOWN_AFTER_APPLY = "(known after apply)";
const COMPUTED = "(computed)";
const UNDEFINED = "(undefined)";
const OPAQUE = "(opaque)";
const CIRCULAR = "(circular)";

/**
 * Turn arbitrary declared inputs or persisted state into safe, deterministic
 * plain data for terminal display. Deferred values are described, never run,
 * and Redacted values are replaced before their contents can reach YAML.
 */
export const toYamlDisplayValue = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): YamlDisplayValue => {
  // Output expressions are Effects too, so this order is security-sensitive.
  if (Redacted.isRedacted(value)) return REDACTED;
  if (Output.isExpr(value)) return KNOWN_AFTER_APPLY;
  if (Effect.isEffect(value) || typeof value === "function") return COMPUTED;
  if (value === undefined) return UNDEFINED;
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (!isPlainData(value)) return OPAQUE;
  if (ancestors.has(value)) return CIRCULAR;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toYamlDisplayValue(item, ancestors));
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [
          key,
          toYamlDisplayValue(
            (value as Record<string, unknown>)[key],
            ancestors,
          ),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
};

/** Format a value as stable, unadorned YAML lines for terminal renderers. */
export const formatYamlLines = (value: unknown): string[] => {
  const yaml = stringify(toYamlDisplayValue(value), {
    lineWidth: 0,
    sortMapEntries: true,
  });
  return (yaml || `${UNDEFINED}\n`).trimEnd().split("\n");
};

/**
 * Build the detailed property document for a plan resource. This compares
 * persisted declared props to desired declared props; it is not cloud drift.
 */
export const formatDeclaredPropertyYaml = (
  oldProps: unknown,
  newProps: unknown,
  action: "create" | "update" | "replace",
): DeclaredPropertyYaml | undefined => {
  const desired = newProps ?? {};
  if (action === "create") {
    return {
      kind: "create",
      lines: ["properties:", ...indent(formatYamlLines(desired))],
    };
  }
  if (
    !havePropsChanged(
      (oldProps ?? {}) as Record<string, unknown>,
      desired as Record<string, unknown>,
    )
  ) {
    return undefined;
  }
  return {
    kind: "change",
    lines: [
      "properties:",
      ...unifiedDriftLines(
        toYamlDisplayValue(oldProps ?? {}),
        toYamlDisplayValue(desired),
        2,
      ),
    ],
  };
};

const indent = (lines: ReadonlyArray<string>, spaces = 2): string[] =>
  lines.map((line) => `${" ".repeat(spaces)}${line}`);
