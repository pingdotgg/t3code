import { defineRule } from "@oxlint/plugins";

const COMBINATOR_PATTERN = /[\s>+~]/u;
// A class, id, attribute, or leading tag narrows a compound. Negated ones don't,
// so `:not(...)` is removed before this check.
const NARROWING_PATTERN = /[.#[]|^[a-z]/iu;
const ROOT_COMPOUND_PATTERN = /^(?:html|body|:root)(?![\w-])/iu;

// group-[...] and peer-[...] match the .group/.peer element, in-[...] matches an
// ancestor, and data-[...] and aria-[...] hold attribute values, not selectors.
const GROUP_PREFIX_PATTERN = /(?:^|:)(?:group|peer)-$/u;
const ANCESTOR_PREFIX_PATTERN = /(?:^|:)in-$/u;
const ATTRIBUTE_PREFIX_PATTERN = /(?:^|:)(?:data|aria)-$/u;
const QUOTED_PATTERN = /(["'])(?:\\.|(?!\1).)*\1/gu;

// A variant's closing bracket is followed by ":" or a group/peer name like "/row:".
const VARIANT_END_PATTERN = /^(?:\/[\w-]+)?:/u;

/** Tailwind arbitrary variants in a class token: top-level `[...]` groups used as variants. */
function variantGroups(token: string): { prefix: string; group: string }[] {
  const groups: { prefix: string; group: string }[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[") {
      if (depth === 0) start = index + 1;
      depth++;
    } else if (char === "]" && depth > 0) {
      depth--;
      if (depth === 0 && VARIANT_END_PATTERN.test(token.slice(index + 1))) {
        groups.push({ prefix: token.slice(0, start - 1), group: token.slice(start, index) });
      }
    }
  }
  return groups;
}

/** Index of the ")" closing the "(" at `open`, or the selector's length. */
function closingParen(selector: string, open: number): number {
  let depth = 0;
  for (let index = open; index < selector.length; index++) {
    if (selector[index] === "(") depth++;
    else if (selector[index] === ")" && --depth === 0) return index;
  }
  return selector.length;
}

/**
 * Whether nothing after `from` in the enclosing branch is joined by a combinator,
 * i.e. the element ending at `from` is the subject that its wrapper matches.
 */
function isWrapperSubject(selector: string, from: number): boolean {
  let depth = 0;
  for (let index = from; index < selector.length; index++) {
    const char = selector[index] ?? "";
    if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) return true;
      depth--;
    } else if (depth > 0) continue;
    else if (char === ",") return true;
    else if (COMBINATOR_PATTERN.test(char)) {
      const next = selector.slice(index).trimStart()[0];
      if (/\s/u.test(char) && (next === undefined || next === ")" || next === ",")) continue;
      return false;
    }
  }
  return true;
}

/** The compound selector each `:has(` in `selector` is attached to. */
function hasCompounds(selector: string): string[] {
  const compounds: string[] = [];
  let index = selector.indexOf(":has(");
  while (index !== -1) {
    let compound = "";
    let depth = 0;
    let subjectEnd = closingParen(selector, index + ":has".length) + 1;
    // Other branches of a selector list are skipped until the wrapper that holds
    // them opens. An unbalanced "(" means the :has() sits inside :not()/:is()/
    // :where(); the compound outside that wrapper applies only when the :has()
    // is in the wrapper's subject position.
    let skippingBranch = false;
    for (let position = index - 1; position >= 0; position--) {
      const char = selector[position] ?? "";
      if (char === ")") depth++;
      else if (char === "(") {
        if (depth > 0) depth--;
        else {
          if (!isWrapperSubject(selector, subjectEnd)) break;
          skippingBranch = false;
          subjectEnd = closingParen(selector, position) + 1;
        }
      } else if (depth === 0 && char === ",") {
        skippingBranch = true;
        continue;
      } else if (depth === 0 && !skippingBranch && COMBINATOR_PATTERN.test(char)) break;
      if (!skippingBranch) compound = char + compound;
    }
    compounds.push(compound);
    index = selector.indexOf(":has(", index + 1);
  }
  return compounds;
}

/** `compound` without any `:not(...)`, including one left open around the `:has()`. */
function withoutNegations(compound: string): string {
  let result = "";
  let index = 0;
  while (index < compound.length) {
    if (!compound.startsWith(":not(", index)) {
      result += compound[index];
      index++;
      continue;
    }
    let depth = 0;
    for (index += ":not".length; index < compound.length; index++) {
      if (compound[index] === "(") depth++;
      else if (compound[index] === ")" && --depth === 0) break;
    }
    index++;
  }
  return result;
}

/** Arbitrary variants in `text` whose `:has()` is unanchored or anchored to the document root. */
function findUnscopedHasVariants(text: string): string[] {
  // Selectors are ASCII case-insensitive.
  if (!text.toLowerCase().includes(":has(")) return [];
  const offenders: string[] = [];
  for (const token of text.split(/\s+/u)) {
    for (const { prefix, group } of variantGroups(token)) {
      if (ATTRIBUTE_PREFIX_PATTERN.test(prefix)) continue;
      // Tailwind writes spaces as "_", and "&" is the element carrying the class.
      // A selector without "&" applies to that element, as `&:is(...)`.
      const relative = group.toLowerCase().replace(QUOTED_PATTERN, '""').replaceAll("_", " ");
      const owner = GROUP_PREFIX_PATTERN.test(prefix) ? ".group" : ".self";
      const selector = ANCESTOR_PREFIX_PATTERN.test(prefix)
        ? `:is(${relative.replaceAll("&", "*")}) .self`
        : relative.includes("&")
          ? relative.replaceAll("&", owner)
          : `${owner}:is(${relative})`;
      const unscoped = hasCompounds(selector).some((compound) => {
        const anchor = withoutNegations(compound);
        return !NARROWING_PATTERN.test(anchor) || ROOT_COMPOUND_PATTERN.test(anchor);
      });
      if (unscoped) offenders.push(`[${group}]`);
    }
  }
  return offenders;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind arbitrary variants with a :has() that is not anchored to a class, attribute, id, or tag.",
    },
  },
  create(context) {
    const message = (variant: string) =>
      `Anchor the :has() in ${variant} to a class, attribute, or tag below the document root, e.g. [&+[data-x]_…] or a has-* variant. Chrome evaluates an unanchored :has() on every ancestor, so any DOM change then restyles the whole page.`;
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        for (const variant of findUnscopedHasVariants(node.value)) {
          context.report({ node, message: message(variant) });
        }
      },
      TemplateElement(node) {
        for (const variant of findUnscopedHasVariants(node.value.cooked ?? node.value.raw)) {
          context.report({ node, message: message(variant) });
        }
      },
    };
  },
});
