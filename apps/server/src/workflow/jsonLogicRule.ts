export const ALLOWED_JSON_LOGIC_OPERATORS = new Set([
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "and",
  "or",
  "!",
  "var",
  "in",
] as const);

/** Maximum nesting depth for a JSON-logic predicate tree.
 *  Generous enough for any real predicate; well below the JS call-stack limit.
 *  Predicates deeper than this are rejected with an `invalid_json_logic` lint error. */
export const MAX_PREDICATE_DEPTH = 12;

export interface JsonLogicRuleIssue {
  readonly message: string;
}

export interface JsonLogicRuleInspection {
  readonly variablePaths: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<JsonLogicRuleIssue>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inspectNode = (
  node: unknown,
  variablePaths: string[],
  seenPaths: Set<string>,
  issues: JsonLogicRuleIssue[],
  depth: number = 0,
): void => {
  if (depth > MAX_PREDICATE_DEPTH) {
    issues.push({
      message: `JSONLogic predicate exceeds maximum nesting depth of ${MAX_PREDICATE_DEPTH}`,
    });
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      inspectNode(item, variablePaths, seenPaths, issues, depth + 1);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }

  const entries = Object.entries(node);
  if (entries.length !== 1) {
    issues.push({ message: "JSONLogic rule objects must contain exactly one operator" });
    for (const value of Object.values(node)) {
      inspectNode(value, variablePaths, seenPaths, issues, depth + 1);
    }
    return;
  }

  const entry = entries[0];
  if (entry === undefined) {
    return;
  }
  const [operator, operand] = entry;
  if (!ALLOWED_JSON_LOGIC_OPERATORS.has(operator as never)) {
    issues.push({ message: `unsupported JSONLogic operator: ${operator}` });
    inspectNode(operand, variablePaths, seenPaths, issues, depth + 1);
    return;
  }

  if (operator === "var") {
    if (typeof operand !== "string") {
      issues.push({ message: "JSONLogic var must be a string path without a default" });
      return;
    }
    if (!seenPaths.has(operand)) {
      seenPaths.add(operand);
      variablePaths.push(operand);
    }
    return;
  }

  inspectNode(operand, variablePaths, seenPaths, issues, depth + 1);
};

export const inspectJsonLogicRule = (rule: unknown): JsonLogicRuleInspection => {
  const variablePaths: string[] = [];
  const issues: JsonLogicRuleIssue[] = [];
  inspectNode(rule, variablePaths, new Set(), issues);
  return { variablePaths, issues };
};
