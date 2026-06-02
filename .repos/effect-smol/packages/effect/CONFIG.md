# Configuration in Effect

This guide shows you how to load and validate configuration in an Effect application. Two modules work together:

- **`ConfigProvider`** — reads raw data from a source (environment variables, JSON objects, `.env` files, directory trees).
- **`Config`** — describes what shape and types you expect, then decodes the raw data into typed values.

You describe _what_ you need with `Config`, and the library figures out _how_ to read and validate it using a `ConfigProvider`.

## Getting Started

### Reading a Single Value

The simplest case: read one value from an environment variable.

```ts
import { Config, Effect } from "effect"

const program = Effect.gen(function*() {
  const host = yield* Config.string("HOST")
  console.log(host)
})

Effect.runSync(program)
// reads HOST from process.env
```

When you yield a `Config` inside `Effect.gen`, it automatically uses the default `ConfigProvider` (which reads from `process.env`).

### Reading Multiple Values

Use `Config.all` to group related keys:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const dbConfig = Config.all({
  host: Config.string("host"),
  port: Config.int("port")
})

const provider = ConfigProvider.fromUnknown({
  host: "localhost",
  port: 5432
})

const result = Effect.runSync(dbConfig.parse(provider))
// { host: "localhost", port: 5432 }
```

### Reading Structured Config with a Schema

For larger configs, use `Config.schema` with a `Schema.Struct`:

```ts
import { Config, ConfigProvider, Effect, Schema } from "effect"

const AppConfig = Config.schema(
  Schema.Struct({
    host: Schema.String,
    port: Schema.Int,
    debug: Schema.Boolean
  })
)

const provider = ConfigProvider.fromUnknown({
  host: "localhost",
  port: 8080,
  debug: true
})

const result = Effect.runSync(AppConfig.parse(provider))
// { host: "localhost", port: 8080, debug: true }
```

The schema automatically decodes raw string values into their target types. For example, when reading from environment variables, `"8080"` becomes the number `8080` and `"true"` becomes the boolean `true`.

## Config Constructors

Each constructor reads a single value and decodes it into the appropriate type.

| Constructor                    | Decoded type       | Notes                                                                    |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------ |
| `Config.string(name?)`         | `string`           | Any string                                                               |
| `Config.nonEmptyString(name?)` | `string`           | Rejects `""`                                                             |
| `Config.number(name?)`         | `number`           | Includes `NaN`, `Infinity`                                               |
| `Config.finite(name?)`         | `number`           | Rejects `NaN` and `Infinity`                                             |
| `Config.int(name?)`            | `number`           | Integers only                                                            |
| `Config.boolean(name?)`        | `boolean`          | Accepts `true/false`, `yes/no`, `on/off`, `1/0`, `y/n`                   |
| `Config.port(name?)`           | `number`           | Integer in 1–65535                                                       |
| `Config.url(name?)`            | `URL`              | Parsed via the `URL` constructor                                         |
| `Config.date(name?)`           | `Date`             | Rejects invalid dates                                                    |
| `Config.duration(name?)`       | `Duration`         | Parses `"10 seconds"`, `"500 millis"`, `"Infinity"`, `"-Infinity"`, etc. |
| `Config.logLevel(name?)`       | `string`           | One of `All`, `Fatal`, `Error`, `Warn`, `Info`, `Debug`, `Trace`, `None` |
| `Config.redacted(name?)`       | `Redacted<string>` | Hidden from logs and `toString`                                          |
| `Config.literal(value, name?)` | literal type       | Accepts only the given literal                                           |

The optional `name` parameter sets the root path segment for lookup. Omit it when the config is part of a larger `Config.schema`.

## Config Combinators

### `Config.withDefault` — Fallback for Missing Keys

Only triggers when data is missing. Validation errors (wrong type, out of range) still propagate.

```ts
import { Config, ConfigProvider, Effect } from "effect"

const port = Config.int("port").pipe(Config.withDefault(3000))

const provider = ConfigProvider.fromUnknown({})
Effect.runSync(port.parse(provider)) // 3000
```

### `Config.option` — Optional Values

Returns `Option.some(value)` on success and `Option.none()` when data is missing.

```ts
import { Config, ConfigProvider, Effect } from "effect"

const maybePort = Config.option(Config.int("port"))

const provider = ConfigProvider.fromUnknown({})
Effect.runSync(maybePort.parse(provider)) // { _tag: "None" }
```

### `Config.map` — Transform a Value

```ts
import { Config } from "effect"

const upperHost = Config.string("HOST").pipe(
  Config.map((s) => s.toUpperCase())
)
```

### `Config.orElse` — Fallback on Any Error

Unlike `withDefault`, this catches **all** `ConfigError`s:

```ts
import { Config } from "effect"

const host = Config.string("HOST").pipe(
  Config.orElse(() => Config.succeed("localhost"))
)
```

### `Config.nested` — Scope Under a Prefix

Prepends a path segment to every key the inner config reads:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const dbConfig = Config.all({
  host: Config.string("host"),
  port: Config.int("port")
}).pipe(Config.nested("database"))

const provider = ConfigProvider.fromUnknown({
  database: { host: "localhost", port: 5432 }
})

Effect.runSync(dbConfig.parse(provider))
// { host: "localhost", port: 5432 }
```

With environment variables, nesting uses `_` as separator:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const host = Config.string("host").pipe(Config.nested("database"))

const provider = ConfigProvider.fromEnv({
  env: { database_host: "localhost" }
})

Effect.runSync(host.parse(provider)) // "localhost"
```

### `Config.all` — Combine Multiple Configs

Accepts a record or a tuple:

```ts
import { Config } from "effect"

// As a record
const appConfig = Config.all({
  host: Config.string("host"),
  port: Config.int("port"),
  debug: Config.boolean("debug")
})

// As a tuple
const pair = Config.all([Config.string("a"), Config.int("b")])
```

## Config Schemas

For reusable codecs you can pass directly to `Config.schema`:

| Schema                      | Type           | Notes                                      |
| --------------------------- | -------------- | ------------------------------------------ |
| `Config.Boolean`            | `boolean`      | Decodes `true/false/yes/no/on/off/1/0/y/n` |
| `Schema.DurationFromString` | `Duration`     | Decodes human-readable duration strings    |
| `Config.Port`               | `number`       | Integer in 1–65535                         |
| `Config.LogLevel`           | `string`       | One of the standard log level literals     |
| `Config.Record(key, value)` | `Record<K, V>` | Also parses flat `"k1=v1,k2=v2"` strings   |

## ConfigProvider Sources

### `ConfigProvider.fromEnv` — Environment Variables (Default)

This is the default provider. Path segments are joined with `_` for lookup.

```ts
import { Config, ConfigProvider, Effect } from "effect"

const provider = ConfigProvider.fromEnv({
  env: {
    DATABASE_HOST: "localhost",
    DATABASE_PORT: "5432"
  }
})

const host = Config.string("HOST").parse(
  provider.pipe(ConfigProvider.nested("DATABASE"))
)

Effect.runSync(host) // "localhost"
```

**How `_` splitting works**: env var names are split on `_` to build a tree. This means `DATABASE_HOST=localhost` is accessible at both `["DATABASE_HOST"]` (flat) and `["DATABASE", "HOST"]` (nested). Querying `["DATABASE"]` returns a Record node with child key `"HOST"`.

Pass `{ env: { ... } }` for testing. Omit to use `process.env` (merged with `import.meta.env` when available).

### `ConfigProvider.fromUnknown` — Plain JS Objects

Ideal for testing or embedding config in code:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const provider = ConfigProvider.fromUnknown({
  database: {
    host: "localhost",
    port: 5432,
    credentials: {
      username: "admin",
      password: "secret"
    }
  },
  servers: ["server1", "server2", "server3"]
})
```

Path traversal follows standard JS rules: string segments index into object keys, numeric segments index into arrays. Primitive values are automatically stringified.

### `ConfigProvider.fromDotEnvContents` — Parse `.env` Strings

When you already have the `.env` content as a string:

```ts
import { ConfigProvider } from "effect"

const contents = `
# Database settings
HOST=localhost
PORT=3000
SECRET="my-secret-value"
`

const provider = ConfigProvider.fromDotEnvContents(contents)
```

Supports `export` prefixes, single/double/backtick quoting, inline comments, and escaped newlines. Enable variable expansion with `{ expandVariables: true }`:

```ts
import { ConfigProvider } from "effect"

const contents = `
PASSWORD=secret
DB_PASS=$PASSWORD
`

const provider = ConfigProvider.fromDotEnvContents(contents, {
  expandVariables: true
})
```

### `ConfigProvider.fromDotEnv` — Load `.env` Files

Reads a `.env` file from disk. Returns an `Effect` (requires `FileSystem` in context):

```ts
import { ConfigProvider, Effect } from "effect"

const program = Effect.gen(function*() {
  const provider = yield* ConfigProvider.fromDotEnv()
  // or: yield* ConfigProvider.fromDotEnv({ path: "/custom/.env" })
  return provider
})
```

### `ConfigProvider.fromDir` — Directory Trees

Reads config from a file-system tree where each file is a leaf and each directory is a container. Useful for Kubernetes ConfigMap/Secret volume mounts.

```
/etc/myapp/
  database/
    host       # contains "localhost"
    port       # contains "5432"
  api_key      # contains "sk-abc123"
```

```ts
import { ConfigProvider, Effect } from "effect"

const program = Effect.gen(function*() {
  const provider = yield* ConfigProvider.fromDir({
    rootPath: "/etc/myapp"
  })
  return provider
})
```

Requires `Path` and `FileSystem` in the Effect context.

### `ConfigProvider.make` — Custom Sources

Build a provider from any backing store:

```ts
import { ConfigProvider, Effect } from "effect"

const data: Record<string, string> = {
  host: "localhost",
  port: "5432"
}

const provider = ConfigProvider.make((path) => {
  const key = path.join(".")
  const value = data[key]
  return Effect.succeed(
    value !== undefined ? ConfigProvider.makeValue(value) : undefined
  )
})
```

Return `undefined` for "not found". Only fail with `SourceError` for actual I/O errors.

## ConfigProvider Combinators

### `ConfigProvider.orElse` — Fallback Sources

Falls back to a second provider when the first returns `undefined` (path not found). Does **not** catch `SourceError`.

```ts
import { ConfigProvider } from "effect"

const envProvider = ConfigProvider.fromEnv({
  env: { HOST: "prod.example.com" }
})
const defaults = ConfigProvider.fromUnknown({
  HOST: "localhost",
  PORT: "3000"
})

const combined = ConfigProvider.orElse(envProvider, defaults)
```

### `ConfigProvider.nested` — Prefix All Lookups

Prepends path segments so that all lookups are scoped:

```ts
import { ConfigProvider } from "effect"

const provider = ConfigProvider.fromEnv({
  env: { APP_HOST: "localhost", APP_PORT: "3000" }
})

// Lookups for ["HOST"] now resolve to ["APP", "HOST"]
const scoped = ConfigProvider.nested(provider, "APP")
```

Accepts a single string or a full `Path` array.

### `ConfigProvider.constantCase` — CamelCase to SCREAMING_SNAKE_CASE

Bridges camelCase schema keys to environment variable naming:

```ts
import { ConfigProvider } from "effect"

const provider = ConfigProvider.fromEnv({
  env: { DATABASE_HOST: "localhost" }
}).pipe(ConfigProvider.constantCase)

// path ["databaseHost"] now resolves to ["DATABASE_HOST"]
```

### `ConfigProvider.mapInput` — Arbitrary Path Transforms

Transform path segments before lookup:

```ts
import { ConfigProvider } from "effect"

const provider = ConfigProvider.fromEnv({
  env: { APP_HOST: "localhost" }
})

const upper = ConfigProvider.mapInput(
  provider,
  (path) => path.map((seg) => typeof seg === "string" ? seg.toUpperCase() : seg)
)
```

## Installing a Provider

### Using `ConfigProvider.layer`

Replaces the active provider for all downstream effects:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const TestLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ port: 8080 })
)

const program = Effect.gen(function*() {
  const port = yield* Config.int("port")
  return port
})

Effect.runSync(Effect.provide(program, TestLayer)) // 8080
```

### Using `ConfigProvider.layerAdd`

Adds a provider without replacing the existing one. By default, the new provider is a **fallback**:

```ts
import { ConfigProvider } from "effect"

const defaults = ConfigProvider.fromUnknown({
  HOST: "localhost",
  PORT: "3000"
})

// process.env is tried first; `defaults` is the fallback
const DefaultsLayer = ConfigProvider.layerAdd(defaults)
```

Set `{ asPrimary: true }` to make the new provider the primary source instead.

### Using `Effect.provideService`

For one-off overrides without layers:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const provider = ConfigProvider.fromUnknown({ HOST: "localhost" })

const program = Effect.gen(function*() {
  const host = yield* Config.string("HOST")
  return host
}).pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, provider)
)
```

## Two Ways to Run a Config

1. **Yield in `Effect.gen`** — automatically uses the current `ConfigProvider` from the service map:

   ```ts
   const program = Effect.gen(function*() {
     const host = yield* Config.string("HOST")
   })
   ```

2. **Call `.parse(provider)` directly** — useful for testing or when you have a specific provider:

   ```ts
   const host = Config.string("HOST")
   const result = Effect.runSync(host.parse(provider))
   ```

## Error Handling

Config operations fail with `ConfigError`, which wraps either:

- **`SourceError`** — the provider could not read data (I/O failure, permission error). Has `message` and optional `cause` properties.
- **`SchemaError`** — data was found but didn't match the schema (wrong type, out of range, missing key).

Check `error.cause._tag` to distinguish:

```ts
import { Config, ConfigProvider, Effect } from "effect"

const program = Config.int("PORT").parse(
  ConfigProvider.fromUnknown({ PORT: "not-a-number" })
).pipe(
  Effect.tapError((error) =>
    Effect.sync(() => {
      if (error.cause._tag === "SchemaError") {
        console.log("Validation failed:", error.message)
      } else {
        console.log("Source error:", error.message)
      }
    })
  )
)
```

**Important**: `Config.withDefault` and `Config.option` only recover from missing-data errors. Validation errors still propagate.

## Practical Example: Web Server Config

```ts
import { Config, ConfigProvider, Effect, Schema } from "effect"

// Define your config shape
const ServerConfig = Config.schema(
  Schema.Struct({
    host: Schema.String,
    port: Schema.Int,
    logLevel: Schema.Literals(["debug", "info", "warn", "error"])
  }),
  "server"
)

const DbConfig = Config.schema(
  Schema.Struct({
    url: Schema.String,
    poolSize: Schema.Int
  }),
  "db"
)

const AppConfig = Config.all({
  server: ServerConfig,
  db: DbConfig,
  debug: Config.boolean("debug").pipe(Config.withDefault(false))
})

// In production, just yield it — reads from process.env
const program = Effect.gen(function*() {
  const config = yield* AppConfig
  console.log(config)
})

// For testing, provide a specific provider
const testProvider = ConfigProvider.fromUnknown({
  server: { host: "localhost", port: 3000, logLevel: "debug" },
  db: { url: "postgres://localhost/testdb", poolSize: 5 },
  debug: true
})

Effect.runSync(
  program.pipe(Effect.provide(ConfigProvider.layer(testProvider)))
)
```

With environment variables, the same config reads:

```
server_host=localhost
server_port=3000
server_logLevel=debug
db_url=postgres://localhost/mydb
db_poolSize=10
debug=true
```
