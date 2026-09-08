# effect

Effect is a library for building robust, maintainable, type-safe, and production grade applications in TypeScript.

The `effect` package is the core of the framework. It provides primitives for managing side effects, errors, concurrency, resources, and structured data, alongside a rich standard library.

## Installation

```sh
npm install effect@rc
```

## Requirements

- **TypeScript 5.9 or newer.** TypeScript 7 is recommended for the best performance and compatibility with [Effect's TypeScript tooling](https://github.com/Effect-TS/tsgo#installation).
- **Node.js 18 or newer** when running Effect on Node.js.
- **Strict type-checking:** the `strict` flag must be enabled in your `tsconfig.json`:

  ```json
  {
    "compilerOptions": {
      "strict": true
    }
  }
  ```

## Documentation

- [Effect website](https://effect.website)
- [API reference](https://effect.website/docs/v4/api/effect)

## Overview

The `effect` package is a collection of modules. Some of the core ones:

| Module   | Description                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| Effect   | The core abstraction for managing side effects, concurrency, and error handling in a structured way.                       |
| Context  | A lightweight dependency injection mechanism that enables passing services through computations without direct references. |
| Layer    | A system for managing dependencies, allowing for modular and composable resource allocation.                               |
| Fiber    | Lightweight virtual threads with resource-safe cancellation capabilities, enabling many features in Effect.                |
| Stream   | A powerful abstraction for handling asynchronous, event-driven data processing.                                            |
| Schedule | A module for defining retry and repeat policies with composable schedules.                                                 |
| Scope    | Manages the lifecycle of resources, ensuring proper acquisition and release.                                               |
| Schema   | A powerful library for defining, validating, and transforming structured data with type-safe encoding and decoding.        |

In v4, functionality that previously lived in separate packages ships inside `effect` under the `effect/unstable/*` namespaces, including `http`, `httpapi`, `rpc`, `cluster`, `workflow`, `cli`, `ai`, `sql`, and `reactivity`.
