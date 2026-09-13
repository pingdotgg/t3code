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

## Example Best Practices

### Quality Checklist

Use this checklist when authoring or reviewing an example:

- **Classify execution:** Make the example clearly one of a runnable observation, typechecked definition, test registration,
  runtime entrypoint, or external-infrastructure illustration. Do not combine alternative runtimes or deployment paths in
  one executable module; present them as separately labeled, non-evaluated alternatives.
- **Order setup, operation, observation:** Make the documented API and its result scannable. Inline simple setup into the
  assertion; otherwise arrange setup first, the operation second, and a separate observation block after one blank line.
- **Teach one primary semantic contract:** Include only the adjacent concepts needed to observe that behavior. Remove unused
  errors, services, imports, alternate programs, and fictional generic-type scaffolding. Integration examples may include
  more concepts only when the integration is the lesson.
- **Observe the promised semantic boundary:** Assert the full semantic value when practical. If unstable or irrelevant data
  requires a projection, choose stable fields that distinguish the promised behavior from neighboring outcomes. For
  example, prefer `Exit.fail("missing")` over observing only `_tag === "Failure"`.
- **Prefer direct observation:** Use the abstraction's return value, collector, or fold before introducing a mutable probe.
  Console output or successful execution alone does not establish semantic behavior.

  Good:

  ```ts
  await Effect.runPromise(Stream.runCollect(Stream.make(1, 2, 3))) // => [1, 2, 3]
  ```

  Counterexample:

  ```ts
  const values: Array<number> = []

  await Effect.runPromise(
    Stream.make(1, 2, 3).pipe(Stream.runForEach((value) => Effect.sync(() => values.push(value))))
  )
  values // => [1, 2, 3]
  ```

- **Use local probes only when the API has no direct result:** A local mutable probe is appropriate for
  `acquireRelease`/finalizers and callback-oriented APIs when lifecycle order or emitted events are the contract. Keep the
  probe local and sequential.

  ```ts
  const events: Array<string> = []
  const resource = Effect.acquireRelease(
    Effect.sync(() => events.push("acquire")),
    () => Effect.sync(() => events.push("release"))
  )

  await Effect.runPromise(Effect.scoped(resource))
  events // => ["acquire", "release"]
  ```

- **Use Effect-managed observers for concurrency:** Prefer `Ref`, `Deferred`, or `Queue` over mutable arrays or flags when
  fibers, concurrent consumers, interruption, or races are part of the behavior.
- **Keep execution bounded and deterministic:** Bound retries, repeats, polling, generated streams, tool loops, and
  concurrent consumers unless non-termination is the documented entrypoint behavior. Avoid live clocks, randomness,
  scheduling accidents, external services, machine-specific state, and unawaited work; use controlled inputs and ensure
  cleanup completes.
- **Choose runners deliberately:** Prefer awaited `Effect.runPromise` in runnable examples. Use `Effect.runSync` only when
  synchronous execution is the documented contract or materially clarifies an Effect known to be synchronous; do not use
  it merely as a shorter doctest runner.
- **Progress multiple examples by behavior:** Move from basic success to a defining boundary or failure, then composition or
  lifecycle behavior. Do not repeat equivalent happy paths with renamed values or alternate syntax unless the calling style
  or overload dispatch is itself part of the contract.
- **Keep type-only examples type-only:** Retain runnable metadata for extraction and typechecking, but do not add tautological
  runtime assertions such as assigning a typed literal and asserting that the literal is unchanged. Add an assertion only
  when the API also performs runtime transformation or validation.

### Doctest Mechanics

- Mark runnable TypeScript examples with `````ts import.meta.vitest`` so `pnpm doctest` executes them.
- Use a trailing `// =>` comment to assert an expression or single initialized `const` identifier against a TypeScript expression on the same line. Values use Effect's `Equal.equals` semantics, and examples without markers remain execution-only. Write asynchronous execution explicitly; the transform does not run Effects or await promises automatically.
- Prefer asserting the API call directly. Keep bindings only for reuse, mutation, identity checks, or meaningful multi-step setup; put a blank line before a separate assertion block.
- Keep calls on one line when the complete line is at most 120 characters. Format expected arrays densely (`[1, 2]`, `[[1], [2]]`, `Option.some([1, 2])`) while retaining normal object spacing.
- Assert semantic constructors such as `Option.some`, `Result.succeed`, and `Exit.fail`, not rendered console output. Preserve runnable markers on type-level examples without adding fake runtime assertions.
- Keep runnable examples complete, deterministic, bounded, and independent of external services or machine-specific state. Await asynchronous work so failures and cleanup remain inside the doctest.
- Import public APIs and include all required setup. Do not use undeclared placeholders or rely on declarations from surrounding prose.
- Leave examples that register Vitest tests or suites as plain `````ts`` fences; the doctest collector executes runnable
  snippets inside tests, where nested test registration is invalid. Invoke registration APIs directly so the snippet still
  shows the intended top-level usage.
- Leave intentionally non-executable snippets as plain `````ts`` fences.
- Run `pnpm doctest --run <source files>` from the repository root after changing runnable examples.
