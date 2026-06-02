---
name: jsdocs
description: Write, insert, or update Effect public API JSDoc so it satisfies the jsdocs oxlint rule. Use when adding or fixing JSDoc comments, resolving jsdocs diagnostics, preparing docs for JSON extraction, or reviewing public API documentation.
---

Use this skill to write well-formed JSDoc for Effect public APIs.

## Workflow

When updating public API JSDoc:

1. Inspect the declaration, implementation, nearby tests, and nearby JSDoc before editing.
2. Decide whether the task is a single API fix or a module refinement pass.
3. Rewrite comments into the required documentation shape while preserving correct facts and examples.
4. For module refinements, complex APIs, or APIs with related alternatives, run the `@see` and `**Gotchas**` audits.
5. Run the narrowest relevant validation.

## Required documentation shape

Use a normal multiline JSDoc comment in TypeScript source:

```ts
/**
 * Short description as one paragraph.
 *
 * **When to use**
 *
 * Optional practical usage guidance.
 *
 * **Details**
 *
 * Optional details for complex APIs, options, overloads, or behavior.
 *
 * **Gotchas**
 *
 * Optional edge cases, footguns, or surprising behavior.
 *
 * **Example** (Short title)
 *
 * Optional prose explaining the example.
 *
 * ```ts
 * const result = example()
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
```

## Prose Rules

- Use sober, practical prose.
- Write all public JSDoc prose in English.
- Do not use jargon when a plain word works.
- Do not be clever.
- Do not add filler sections.
- The short description is required and must be exactly one paragraph.
- Make the short description stand on its own. Do not rely on `**When to use**`
  to make the API understandable.
- For functions and methods, prefer present-tense, action-first prose such as
  `Creates`, `Returns`, `Checks`, `Provides`, `Represents`, `Converts`,
  `Decodes`, or `Formats`.
- For technical value exports, use consistent noun forms such as `Schema for`,
  `Layer that`, `Service that`, `Context reference that`, or
  `Constructors and matchers for`.
- Avoid leading `A` or `An` for canonical technical nouns when the surrounding
  module uses a standard noun family, for example prefer `Schema for ...` over
  `A schema for ...`.
- Do not describe implementation mechanics when a public concept is clearer.
  For example, prefer `Constructors and matchers for ...` over wording that
  only says an API uses `Data.taggedEnum`.
- Avoid generic purity or non-mutation remarks unless they document a real
  surprise, caveat, or meaningful contrast with a mutating-looking API.
- Optional sections must appear in this order:
  1. `**When to use**`
  2. `**Details**`
  3. `**Gotchas**`
- Include an optional section only when it has useful, non-empty content.
- Prefer prose over bullet lists for single-item `**Details**`, `**When to use**`, or `**Gotchas**` sections. Use bullets only when there are two or more parallel facts, options, cases, or caveats.
- `**When to use**` describes the positive use case for the documented API. Do not use it as a routing section for sibling APIs. If neighboring APIs need to be mentioned, put that boundary in `@see` tag text instead.
- `**When to use**` is important when the API has close alternatives, trade-offs, or `@see` tags. If `@see` tags are present, inspect the referenced APIs and add `**When to use**` when it clarifies the documented API's own use case.
- `**When to use**` must start with one of these practical guidance forms: `Use to`, `Use when`, `Use as`, or `Use with`. Avoid bullet lists and vague openers such as `Use this...` or `Useful for...`.
- Keep `short` and `**When to use**` distinct: the short description says what
  the API is or does; `**When to use**` says when to choose it.
- Add internal `@see` tags only for semantically useful related public APIs.
- Write `@see` tag text as normal prose after the link; no special separator is required. Prefer forms like `@see {@link otherApi} for ...` when a short explanation helps.
- Use exactly one blank line between the short description, sections, examples, and tags.
- Do not use Markdown headings such as `# Heading` or ad hoc bold headings such as `**Notes**`; only the standard headings are allowed.
- Examples must use `**Example** (Title)`, optional prose, and exactly one non-empty `ts` code fence.
- Example titles must be unique after trimming and lowercasing.
- Prefer examples with stable, deterministic output. Avoid assertions or
  `console.log` comments that depend on stack traces, object inspection,
  `Error` formatting, concurrency order, timing, randomness, or
  environment-specific formatting. Examples may assume Node.js console
  formatting. Direct `Set` / `Map` output is acceptable when insertion order is
  deterministic and the expected output uses Node's format; otherwise
  demonstrate a stable property instead.
- Do not use `@example`.
- Do not put TypeScript code fences outside `**Example** (Title)` sections.
- Inline `{@link Symbol}` targets must resolve to TypeScript symbols; do not link to URLs with `{@link}`.
- Avoid overlinking in prose. Use `{@link Symbol}` only when navigation to
  that symbol helps the reader choose or understand the API. For the API being
  documented, the module's central type, nearby obvious names, or repeated
  mentions, prefer plain code formatting such as `Cause`, `Effect`, or
  `Context`.
- Do not document module-level comments; module JSDoc is ignored by this rule.
- `@internal` means the item is ignored; do not rewrite it as public docs.
- Default exports are ignored by this rule and do not need JSDoc.
- Do not add unsupported constructs such as enums or empty exports in checked files.
- For low-level public values, prefer accurate categories such as `symbols`,
  `type IDs`, or `prototypes` over compensating with verbose descriptions.

## Tag rules

When multiple tags are present, keep them in this order:

1. `@deprecated`
2. `@default`
3. `@see`
4. `@category`
5. `@since`

Tag requirements by declaration kind:

- Root declarations require `@category` and stable-semver `@since`, and must
  not use `@default`.
- Namespaces and declarations inside namespaces require stable-semver `@since`,
  may use `@category`, and must not use `@default`.
- Member JSDoc is optional. When present, it follows the same prose and layout
  rules, may use optional stable-semver `@since`, may use non-empty `@default`,
  and must not use `@category`.
- Any declaration may use `@deprecated` with a non-empty message and repeated
  non-empty `@see` tags for semantically useful related public APIs.

## Updating existing JSDoc

When fixing or updating existing docs:

1. Preserve correct facts and examples.
2. Rewrite the layout into the standard template.
3. Move usage guidance into `**When to use**`, behavior details into `**Details**`, and real caveats into `**Gotchas**`.
4. Convert `@example` tags and loose `ts` fences into `**Example** (Title)` sections.
5. Preserve valid `@see`, `@deprecated`, `@default`, `@category`, and `@since` tags.
6. Remove `@see` tags that do not point to semantically useful related public APIs.
7. Replace redundant inline `{@link ...}` tags with plain code formatting when
   the link target is already obvious from the current declaration or module.
8. Remove sections that would be empty.

## Module refinement

When asked to refine an existing module:

1. First scan the module for local documentation patterns, repeated API families, and category conventions.
2. Keep the change focused on documentation quality unless the user also asked for rule or source changes.
3. Prefer improving existing comments over rewriting every comment into a new voice.
4. Preserve examples unless they are wrong, stale, nondeterministic, or fail
   the required documentation shape.
5. Apply the `@see` and `**Gotchas**` audits across the module before finishing.

## See audit

When refining an existing public API module, always do a dedicated `@see` pass:

1. Inspect existing `@see` tags and referenced APIs before keeping, changing, or removing them.
2. Look for close alternatives in the same module or API family when the documented API is one of several ways to do similar work.
3. Keep or add `@see` only when the linked API is semantically useful to understand the documented API.
4. Good `@see` targets include sibling APIs, alternatives, inverse operations, lower-level or higher-level variants, complementary operations, and closely returned, consumed, or configured types/values.
5. Do not use `@see` for implementation dependencies, broad concepts, external background links, APIs that merely share a word or name, helper APIs used only inside examples, undocumented/private members, or APIs that are only generally compatible.
6. When `@see` tags are kept or added, include `**When to use**` guidance if the documented API's own use case is not obvious from the short description. Keep comparisons with sibling APIs in the `@see` tag text.

## Gotchas audit

When refining an existing public API module, always do a dedicated `**Gotchas**` pass:

1. Scan existing prose for caveat language: warnings, exceptions, limitations, preconditions, special cases, or behavior that is easy to misuse.
2. Inspect the implementation and nearby tests for behavior that is not obvious from the type signature or short description.
3. Move real caveats from `**Details**` into `**Gotchas**` when they describe edge cases, footguns, preconditions, surprising behavior, or important failure modes.
4. Add `**Gotchas**` only when the caveat is concrete and useful to a reader choosing or using the API.
5. If no gotchas are added during a refinement pass, state that a gotchas audit was performed and why no caveats were worth documenting.

## Validation

Run the narrowest validation that matches the change:

- For JSDoc or example changes in a package with generated docs, run `pnpm docgen` from that package directory.
- Run `pnpm lint` because the linter includes the custom rule that checks public API JSDoc.
- Do not run broad validation for prose-only skill edits.
