<!-- Use a static Shields badge because pkg.pr.new's dynamic badge times out while counting this repository's releases. -->

[![pkg.pr.new](https://img.shields.io/badge/pkg.pr.new-Effect--TS%2Feffect-black)](https://pkg.pr.new/~/Effect-TS/effect)

# Effect

Effect is a library for building robust, maintainable, type-safe, and production grade applications in TypeScript. It helps you handle the hard problems at scale: typed errors, dependency injection, structured concurrency, scheduling, tracing, and unified schema validation.

> **Effect V4 is currently a release candidate.** The `main` branch contains v4 development.

## Install V4 RC

```sh
npm install effect@rc
```

## Requirements

- **TypeScript 5.9 or newer.** TypeScript 7 is recommended for the best performance and compatibility with [Effect's TypeScript tooling](https://github.com/Effect-TS/tsgo#installation).
- **Node.js 18 or newer** is the general minimum for running Effect on Node.js. Some integration packages require newer runtimes; for example, `@effect/sql-sqlite-node` requires Node.js 22.16 or newer.
- **Strict type-checking:** the `strict` flag must be enabled in your `tsconfig.json`.

## Effect v3

The Effect v3 source code is available on the [`v3`](https://github.com/Effect-TS/effect/tree/v3) branch, which is also where issues and pull requests meant for Effect v3 should be targeted.

## Packages

This monorepo contains the core `effect` package alongside integration packages that extend it. All v4 packages are published under the `rc` tag on npm.

| Package                                                               | Description                                              | API Reference                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| [`effect`](packages/effect)                                           | The core package                                         | [docs](https://effect.website/docs/v4/api/effect)                  |
| [`@effect/platform-browser`](packages/platform/browser)               | Platform services for the browser                        | [docs](https://effect.website/docs/v4/api/platform-browser)        |
| [`@effect/platform-bun`](packages/platform/bun)                       | Platform services for [Bun](https://bun.sh)              | [docs](https://effect.website/docs/v4/api/platform-bun)            |
| [`@effect/platform-deno`](packages/platform/deno)                     | Platform services for [Deno](https://deno.com)           | [docs](https://effect.website/docs/v4/api/platform-deno)           |
| [`@effect/platform-node`](packages/platform/node)                     | Platform services for [Node.js](https://nodejs.org)      | [docs](https://effect.website/docs/v4/api/platform-node)           |
| [`@effect/platform-node-shared`](packages/platform/node-shared)       | Shared services for Node.js-compatible runtimes          | [docs](https://effect.website/docs/v4/api/platform-node-shared)    |
| [`@effect/sql-clickhouse`](packages/sql/clickhouse)                   | SQL client for [ClickHouse](https://clickhouse.com)      | [docs](https://effect.website/docs/v4/api/sql-clickhouse)          |
| [`@effect/sql-d1`](packages/sql/d1)                                   | SQL client for Cloudflare D1                             | [docs](https://effect.website/docs/v4/api/sql-d1)                  |
| [`@effect/sql-libsql`](packages/sql/libsql)                           | SQL client for libSQL                                    | [docs](https://effect.website/docs/v4/api/sql-libsql)              |
| [`@effect/sql-mssql`](packages/sql/mssql)                             | SQL client for Microsoft SQL Server                      | [docs](https://effect.website/docs/v4/api/sql-mssql)               |
| [`@effect/sql-mysql2`](packages/sql/mysql2)                           | SQL client for MySQL                                     | [docs](https://effect.website/docs/v4/api/sql-mysql2)              |
| [`@effect/sql-pg`](packages/sql/pg)                                   | SQL client for PostgreSQL                                | [docs](https://effect.website/docs/v4/api/sql-pg)                  |
| [`@effect/sql-pglite`](packages/sql/pglite)                           | SQL client for [PGlite](https://pglite.dev)              | [docs](https://effect.website/docs/v4/api/sql-pglite)              |
| [`@effect/sql-sqlite-bun`](packages/sql/sqlite-bun)                   | SQL client for SQLite via `bun:sqlite`                   | [docs](https://effect.website/docs/v4/api/sql-sqlite-bun)          |
| [`@effect/sql-sqlite-do`](packages/sql/sqlite-do)                     | SQL client for Cloudflare Durable Objects SQLite         | [docs](https://effect.website/docs/v4/api/sql-sqlite-do)           |
| [`@effect/sql-sqlite-node`](packages/sql/sqlite-node)                 | SQL client for SQLite via `node:sqlite`                  | [docs](https://effect.website/docs/v4/api/sql-sqlite-node)         |
| [`@effect/sql-sqlite-react-native`](packages/sql/sqlite-react-native) | SQL client for SQLite in React Native                    | [docs](https://effect.website/docs/v4/api/sql-sqlite-react-native) |
| [`@effect/sql-sqlite-wasm`](packages/sql/sqlite-wasm)                 | SQL client for SQLite compiled to WebAssembly            | [docs](https://effect.website/docs/v4/api/sql-sqlite-wasm)         |
| [`@effect/ai-anthropic`](packages/ai/anthropic)                       | Anthropic provider for the Effect AI modules             | [docs](https://effect.website/docs/v4/api/ai-anthropic)            |
| [`@effect/ai-openai`](packages/ai/openai)                             | OpenAI provider for the Effect AI modules                | [docs](https://effect.website/docs/v4/api/ai-openai)               |
| [`@effect/ai-openai-compat`](packages/ai/openai-compat)               | OpenAI-compatible API provider for the Effect AI modules | [docs](https://effect.website/docs/v4/api/ai-openai-compat)        |
| [`@effect/ai-openrouter`](packages/ai/openrouter)                     | OpenRouter provider for the Effect AI modules            | [docs](https://effect.website/docs/v4/api/ai-openrouter)           |
| [`@effect/atom-react`](packages/atom/react)                           | React bindings for Effect Atom                           | [docs](https://effect.website/docs/v4/api/atom-react)              |
| [`@effect/atom-solid`](packages/atom/solid)                           | SolidJS bindings for Effect Atom                         | [docs](https://effect.website/docs/v4/api/atom-solid)              |
| [`@effect/atom-vue`](packages/atom/vue)                               | Vue bindings for Effect Atom                             | [docs](https://effect.website/docs/v4/api/atom-vue)                |
| [`@effect/opentelemetry`](packages/opentelemetry)                     | [OpenTelemetry](https://opentelemetry.io) integration    | [docs](https://effect.website/docs/v4/api/opentelemetry)           |
| [`@effect/vitest`](packages/vitest)                                   | Helpers for testing with [Vitest](https://vitest.dev)    | [docs](https://effect.website/docs/v4/api/vitest)                  |
| [`@effect/docgen`](packages/tools/docgen)                             | Documentation generator for Effect projects              | [docs](https://effect.website/docs/v4/api/docgen)                  |
| [`@effect/doctest`](packages/tools/doctest)                           | Runs JSDoc examples as Vitest tests                      | [docs](https://effect.website/docs/v4/api/doctest)                 |
| [`@effect/openapi-generator`](packages/tools/openapi-generator)       | Generate Effect code from OpenAPI specifications         | [docs](https://effect.website/docs/v4/api/openapi-generator)       |

## Resources

- Documentation (https://effect.website)
- Discord (https://discord.gg/effect-ts)
- Effect v3 source (https://github.com/Effect-TS/effect/tree/v3)
- Effect v4 source (https://github.com/Effect-TS/effect/tree/main)

## License

MIT
