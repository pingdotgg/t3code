/** Augment this interface with `tags: "unit" | "e2e" | ...` to constrain tags. */
export interface TestTags {}

export type TestTag = TestTags extends { tags: infer T extends string }
  ? T
  : string;

export type Tags = TestTag | ReadonlyArray<TestTag>;

/** Merge inherited labels without changing runner options or execution mode. */
export const mergeTags = (
  inherited: ReadonlyArray<string>,
  tags?: Tags,
): ReadonlyArray<string> => {
  const own = typeof tags === "string" ? [tags] : (tags ?? []);
  for (const tag of own) {
    if (!tag || /[\s()&|!*]/.test(tag) || /^(and|or|not)$/i.test(tag)) {
      throw new Error(`Invalid test tag: ${JSON.stringify(tag)}`);
    }
  }
  return [...new Set([...inherited, ...own])];
};

export type TagsFilter = (
  tags: ReadonlyArray<string>,
  optInTags?: ReadonlyArray<string>,
) => boolean;

/**
 * Compile a tag expression: `!` / `not`, `&&` / `and`, `||` / `or`,
 * parentheses, and `*` wildcards. Repeated expressions are ANDed together.
 * Parse eagerly so malformed filters fail before any test file is imported.
 */
export const compileTagsFilter = (
  expressions: ReadonlyArray<string>,
): TagsFilter => {
  const explicitlySelected = new Set<string>();
  const filters = expressions.map((expression): TagsFilter => {
    const tokens = expression.match(/&&|\|\||[()!&|]|[^\s()!&|]+/g) ?? [];
    let position = 0;
    let negationDepth = 0;
    const fail = (): never => {
      throw new Error(
        `Invalid --tags ${JSON.stringify(expression)}: unexpected ${
          tokens[position] === undefined
            ? "end of expression"
            : JSON.stringify(tokens[position])
        }`,
      );
    };
    const take = (...values: string[]): boolean => {
      if (!values.includes(tokens[position]?.toLowerCase() ?? "")) return false;
      position++;
      return true;
    };
    const primary = (): TagsFilter => {
      if (take("!", "not")) {
        negationDepth++;
        const operand = primary();
        negationDepth--;
        return (tags) => !operand(tags);
      }
      if (take("(")) {
        const inner = or();
        if (!take(")")) fail();
        return inner;
      }
      const token = tokens[position];
      if (
        token === undefined ||
        /^[()&|!]$/.test(token) ||
        /^(and|or|&&|\|\|)$/i.test(token)
      )
        return fail();
      position++;
      // A wildcard or a reference anywhere inside negation is not an opt-in.
      if (negationDepth === 0 && !token.includes("*")) {
        explicitlySelected.add(token);
      }
      const pattern = new RegExp(
        `^${token
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      return (tags) => tags.some((tag) => pattern.test(tag));
    };
    const and = (): TagsFilter => {
      let left = primary();
      while (take("&&", "and")) {
        const previous = left;
        const right = primary();
        left = (tags) => previous(tags) && right(tags);
      }
      return left;
    };
    const or = (): TagsFilter => {
      let left = and();
      while (take("||", "or")) {
        const previous = left;
        const right = and();
        left = (tags) => previous(tags) || right(tags);
      }
      return left;
    };
    const result = or();
    if (position !== tokens.length) fail();
    return result;
  });
  return (tags, optInTags = []) =>
    optInTags.every((tag) => explicitlySelected.has(tag)) &&
    filters.every((filter) => filter([...tags, ...optInTags]));
};
