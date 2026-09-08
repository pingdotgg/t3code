# @effect/doctest

`@effect/doctest` extracts marked TypeScript examples from JSDoc comments, Markdown, and MDX files, then runs each example as an isolated Vitest module.

## Installation

```sh
npm install -D @effect/doctest@rc
```

## Documentation

- [Effect website](https://effect.website)
- [API reference](https://effect.website/docs/v4/api/doctest)

## Usage

Mark runnable fences with `import.meta.vitest`:

````ts
/**
 * ```ts import.meta.vitest name="adds two numbers"
 * 1 + 1 // => 2
 * ```
 */
export const value = 1
````

The optional `name="..."` metadata labels the test without appearing in the example body. Unnamed examples use the opening fence line, such as `line 12`; Vitest displays the containing file alongside it.

## Inline assertions

Add a trailing `// =>` comment to assert the value of an expression:

````ts
/**
 * ```ts import.meta.vitest
 * import { Array, Option } from "effect"
 *
 * Array.get([1, 2, 3], 1) // => Option.some(2)
 * Array.get([1, 2, 3], 10) // => Option.none()
 * ```
 */
export const value = 1
````

The expected value is a TypeScript expression evaluated in the same lexical scope. Values are compared with Effect's `Equal.equals` semantics, so the convention supports primitives, arrays, plain objects, and Effect data types such as `Option`, `Result`, `Exit`, and `HashMap` without converting them to console output.

Prefer asserting the API call directly instead of introducing a binding used only by the assertion. Keep bindings for reuse or meaningful multi-step setup, with a blank line before a later assertion block. Keep the call and assertion on one line when it fits within 120 characters, and format expected arrays densely, for example `[1, 2]`, `[[1], [2]]`, and `Option.some([1, 2])`. Preserve runnable markers on type-level examples without adding tautological runtime assertions.

An assertion may also trail a single initialized `const` declaration with an identifier binding. The initializer is evaluated once and the binding remains available to subsequent code:

````ts
/**
 * ```ts import.meta.vitest
 * import { Effect, Option } from "effect"
 *
 * const result = await Effect.runPromise(Effect.succeed(Option.some(1))) // => Option.some(1)
 * Option.isSome(result) // => true
 * ```
 */
export const value = 1
````

Markers must trail a complete expression statement or supported `const` declaration on the same line. Standalone markers, destructuring declarations, multiple declarations, and `let` or `var` declarations are not supported. The transform does not implicitly await promises, run Effects, or consume iterators; write those operations explicitly. Ordinary comments are ignored. Await asynchronous work so all assertions and cleanup occur before the snippet module finishes evaluating.

Regular tests can use `include` in the same project. Documentation sources use `includeSource`, which lets Vitest discard files without the marker before collection. The plugin resolves imports relative to each example's original TypeScript, Markdown, or MDX file:

```ts
import * as Doctest from "@effect/doctest/Plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [Doctest.plugin()],
  test: {
    include: ["test/**/*.test.ts"],
    includeSource: ["src/**/*.ts", "docs/**/*.{md,mdx}"]
  }
})
```

Source files selected by `includeSource` are collected through generated doctest collectors and are not executed. Native in-source tests using `import.meta.vitest` are therefore not supported by this plugin. Regular test files included through `test.include` continue to run normally.

The plugin configures `@effect/doctest/Runner` when no test runner is specified. If `test.runner` is already configured, the plugin leaves it unchanged; that runner is then responsible for integrating doctest collection when required.
