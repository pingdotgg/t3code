# JSDoc Patterns

## `@category` Guidance

When adding or vetting JSDoc categories in public source files:

- Use exactly one `@category` tag for each public JSDoc block that represents a documented API.
- Use shared categories consistently across the repository. Domain-specific categories are allowed when they improve navigation within a file or package, but avoid one-off categories unless they name an important API/domain concept.
- Prefer lowercase category names by default, plural nouns for API buckets, and gerunds for operation families.
- Preserve canonical casing for acronyms and proper API/domain names, such as `type IDs`, `DateTime`, `Undici`, and `HttpAgent`.
- Prefer shared API-shape categories for common Effect/library patterns, and use domain-topic categories only when they provide clearer navigation.
- Avoid vague fallback categories. Do not use `utils`, `common`, or `misc`; pick a specific shared or domain category instead.

## Common Shared Categories

- API shapes: `constructors`, `destructors`, `models`, `schemas`, `guards`, `predicates`, `getters`, `accessors`, `instances`, `constants`, `protocols`, `prototypes`, `re-exports`, `unsafe`, `testing`
- Effect/service concepts: `services`, `tags`, `layers`, `context`, `resource management`, `running`
- Type-level APIs: `utility types` for type-level helpers/contracts; use `models` for exported type/interface/class shapes that represent domain data
- Error APIs: `errors` for error models/classes/types, `error handling` for recovery/catching/mapping APIs
- Operations: `combinators`, `filtering`, `mapping`, `sequencing`, `zipping`, `combining`, `merging`, `converting`, `transforming`, `folding`, `splitting`, `repetition`
- Encoding/data formats: `encoding`, `decoding`, `serialization`
- Observability: `tracing`, `metrics`, `logging`
- Other common concepts: `annotations`, `references`, `symbols`, `type IDs`, `configuration`, `math`, `comparisons`, `ordering`

## Category Normalization

Normalize category names before adding or reviewing JSDoc:

- Lowercase plain category names. Preserve established acronyms and proper
  names, such as `type IDs`, `DateTime`, `JSON getters`, `Base64 getters`, and
  `Standard Schema`.
- Prefer shared plural buckets when the meaning is the same, such as
  `constructors`, `models`, `schemas`, `guards`, `getters`, `services`,
  `layers`, `generators`, `subscriptions`, `cookies`, and `sizes`.
- Prefer shared operation families over narrow synonyms when precision is not
  important, such as `combining`, `mapping`, `filtering`, `folding`,
  `converting`, `transforming`, `sequencing`, and `repetition`.
- Replace vague fallback categories such as `utils`, `common`, `misc`, or
  `helpers` with a specific shared or domain category.
- Use `services` for `Context.Service` and `Context.Reference` exports, and
  use `tags` only for `Context.Tag` exports.
- Fix obvious typos and compact variants during cleanup, such as
  `transferables`, `re-exports`, `resource management`, and `Standard Schema`.

## Distinctions

Keep these distinctions:

- `services` are `Context.Service` / `Context.Reference` exports and service contracts/shapes, `tags` are `Context.Tag` exports, and `layers` provide services.
- `getters` retrieve values/properties, while `accessors` are contextual service or environment access helpers.
- `errors` are error data types, while `error handling` is for APIs that handle failures.
- `models` describe domain/API data structures, while `schemas` are schema values/combinators and `utility types` are type-level helpers/contracts.
- `guards` are TypeScript type guards, `predicates` are boolean tests, and `filtering` is for filtering operations.
