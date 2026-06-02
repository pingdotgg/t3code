# JSDoc Patterns

## `@category` Guidance

When adding or vetting JSDoc categories in public source files:

- Use exactly one `@category` tag for each public JSDoc block that represents a documented API.
- Use shared categories consistently across the repository. Domain-specific categories are allowed when they improve navigation within a file or package, but avoid one-off categories unless they name an important API/domain concept.
- Prefer lowercase category names by default, plural nouns for API buckets, and gerunds for operation families.
- Preserve canonical casing for acronyms and proper API/domain names, such as `type IDs`, `DateTime`, `Undici`, and `HttpAgent`.
- Prefer shared API-shape categories for common Effect/library patterns, and use domain-topic categories only when they provide clearer navigation.
- Avoid vague fallback categories. Use `utils` only when no more specific shared or domain category fits; avoid `common` and do not use `misc`.

## Common Shared Categories

- API shapes: `constructors`, `destructors`, `models`, `schemas`, `guards`, `predicates`, `getters`, `accessors`, `instances`, `constants`, `protocols`, `prototypes`, `re-exports`, `unsafe`, `testing`
- Effect/service concepts: `services`, `tags`, `layers`, `context`, `resource management`, `running`
- Type-level APIs: `utility types` for type-level helpers/contracts; use `models` for exported type/interface/class shapes that represent domain data
- Error APIs: `errors` for error models/classes/types, `error handling` for recovery/catching/mapping APIs
- Operations: `combinators`, `filtering`, `mapping`, `sequencing`, `zipping`, `converting`, `transforming`, `folding`, `splitting`, `concatenating`
- Encoding/data formats: `encoding`, `decoding`, `serialization`
- Observability: `tracing`, `metrics`, `logging`
- Other common concepts: `annotations`, `references`, `symbols`, `type IDs`, `configuration`, `math`, `comparisons`, `ordering`, `utils`

## Alias Normalization

Normalize high-confidence aliases, for example:

- `Constructors` / `constructor` -> `constructors`
- `Layers` / `layer` -> `layers`
- `Models` / `Model` / `model` -> `models`
- `Combinators` -> `combinators`
- `Accessors` -> `accessors`
- `Guards` / `Guard` -> `guards`
- `Middleware` -> `middleware`
- `error` -> `errors`
- `Error Handling` -> `error handling`
- `Equivalence` -> `instances`
- `Scope` -> `resource management`
- `Wrapper` -> `wrapping`
- `Rate Limiting` -> `rate limiting`
- `Memory` -> `memory`
- `Config` -> `configuration`
- `Epoch` -> `constants`
- `Registry` -> `services`
- `Reflection` -> `reflection`
- `Modifiers` -> `modifiers`
- `Testing` -> `testing`
- `Token` -> `token`
- `Grouping` -> `grouping`
- `tranferables` -> `transferables`
- `Computer Use` -> `computer use`
- `Text Editor` -> `text editor`
- `Tool Search` -> `tool search`
- `Type IDs` / `type ids` -> `type IDs`
- `Services` / `Service` / `service` -> `services`
- `Re-exports` -> `re-exports`
- `protocol` -> `protocols`
- `Result` -> `results`
- `Boundaries` -> `boundaries`
- `Taking` -> `taking`
- `order` -> `ordering`
- `date & time` -> `DateTime`
- `serialization / deserialization` -> `serialization`
- `conversions` -> `converting`
- `transformations` -> `transforming`
- `Resource Management & Finalization` -> `resource management`
- `Run main` -> `running`
- `provider options` -> `configuration`
- `utilities` / `Utilities` -> `utils`

## Distinctions

Keep these distinctions:

- `services` are service contracts/shapes, `tags` identify services in `Context`, and `layers` provide services.
- `getters` retrieve values/properties, while `accessors` are contextual service or environment access helpers.
- `errors` are error data types, while `error handling` is for APIs that handle failures.
- `models` describe domain/API data structures, while `schemas` are schema values/combinators and `utility types` are type-level helpers/contracts.
- `guards` are TypeScript type guards, `predicates` are boolean tests, and `filtering` is for filtering operations.
