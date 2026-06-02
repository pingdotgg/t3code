# Effect library documentation

This documentation resides in the Effect monorepo, which contains the source
code for the Effect library and its related packages.

When you need to find any information about the Effect library, only use this
documentation and the source code found in `./packages`. Do not use
`node_modules` or any other external documentation, as it may be outdated or
incorrect.

**Note**: The examples in this documentation contain comments for illustration
purposes. In practice, you would not include these comments in your code.

## Writing `Effect` code

Prefer writing Effect code with `Effect.gen` & `Effect.fn("name")`. Then attach
additional behaviour with combinators. This style is more readable and easier to
maintain than using combinators alone.

### Using Effect.gen

Use `Effect.gen` to write code in an imperative style similar to async await.
You can use `yield*` to access the result of an effect.

```ts
import { Effect, Schema } from "effect"

Effect.gen(function*() {
  yield* Effect.log("Starting the file processing...")
  yield* Effect.log("Reading file...")

  // Always return when raising an error, to ensure typescript understands that
  // the function will not continue executing.
  return yield* new FileProcessingError({ message: "Failed to read the file" })
}).pipe(
  // Add additional functionality with .pipe
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.withSpan("fileProcessing", {
    attributes: {
      method: "Effect.gen"
    }
  })
)

// Use Schema.TaggedErrorClass to define a custom error
export class FileProcessingError extends Schema.TaggedErrorClass<FileProcessingError>()("FileProcessingError", {
  message: Schema.String
}) {}
```

### Using Effect.fn

When writing functions that return an Effect, use `Effect.fn` to use the
generator syntax.

**Avoid creating functions that return an Effect.gen**, use `Effect.fn`
instead.

```ts
import { Effect, Schema } from "effect"

// Pass a string to Effect.fn, which will improve stack traces and also
// attach a tracing span (using Effect.withSpan behind the scenes).
//
// The name string should match the function name.
//
export const effectFunction = Effect.fn("effectFunction")(
  // You can use `Effect.fn.Return` to specify the return type of the function.
  // It accepts the same type parameters as `Effect.Effect`.
  function*(n: number): Effect.fn.Return<string, SomeError> {
    yield* Effect.logInfo("Received number:", n)

    // Always return when raising an error, to ensure typescript understands that
    // the function will not continue executing.
    return yield* new SomeError({ message: "Failed to read the file" })
  },
  // Add additional functionality by passing in additional arguments.
  // **Do not** use .pipe with Effect.fn
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.annotateLogs({
    method: "effectFunction"
  })
)

// Use Schema.TaggedErrorClass to define a custom error
export class SomeError extends Schema.TaggedErrorClass<SomeError>()("SomeError", {
  message: Schema.String
}) {}
```

### More examples

- **[Creating effects from common sources](./ai-docs/src/01_effect/01_basics/10_creating-effects.ts)**:
  Learn how to create effects from various sources, including plain values,
  synchronous code, Promise APIs, optional values, and callback-based APIs.

## Writing Effect services

Effect services are the most common way to structure Effect code. Prefer using
services to encapsulate behaviour over other approaches, as it ensures that your
code is modular, testable, and maintainable.

### Context.Service

The default way to define a service is to extend `Context.Service`,
passing in the service interface as a type parameter.

```ts
// file: src/db/Database.ts
import { Context, Effect, Layer, Schema } from "effect"

// Pass in the service class name as the first type parameter, and the service
// interface as the second type parameter.
export class Database extends Context.Service<Database, {
  query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>
}>()(
  // The string identifier for the service, which should include the package
  // name and the subdirectory path to the service file.
  "myapp/db/Database"
) {
  // Attach a static layer to the service, which will be used to provide an
  // implementation of the service.
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function*() {
      // Define the service methods using Effect.fn
      const query = Effect.fn("Database.query")(function*(sql: string) {
        yield* Effect.log("Executing SQL query:", sql)
        return [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]
      })

      // Return an instance of the service using Database.of, passing in an
      // object that implements the service interface.
      return Database.of({
        query
      })
    })
  )
}

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect
}) {}

// If you ever need to access the service type, use `Database["Service"]`
export type DatabaseService = Database["Service"]
```

### More examples

- **[Context.Reference](./ai-docs/src/01_effect/02_services/10_reference.ts)**: For defining configuration values, feature flags, or any other service that has a default value.
- **[Composing services with the Layer module](./ai-docs/src/01_effect/02_services/20_layer-composition.ts)**:
  Build focused service layers, then compose them with `Layer.provide` and
  `Layer.provideMerge` based on what services you want to expose.
- **[Creating Layers from configuration and/or Effects](./ai-docs/src/01_effect/02_services/20_layer-unwrap.ts)**: Build a layer dynamically from an Effect / Config with `Layer.unwrap`.

## Error handling

### Error handling basics

Defining custom errors and handling them with Effect.catch and Effect.catchTag.

```ts
import { Effect, Schema } from "effect"

// Define custom errors using Schema.TaggedErrorClass
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  input: Schema.String,
  message: Schema.String
}) {}

export class ReservedPortError extends Schema.TaggedErrorClass<ReservedPortError>()("ReservedPortError", {
  port: Schema.Number
}) {}

declare const loadPort: (input: string) => Effect.Effect<number, ParseError | ReservedPortError>

export const recovered = loadPort("80").pipe(
  // Catch multiple errors with Effect.catchTag, and return a default port number.
  Effect.catchTag(["ParseError", "ReservedPortError"], (_) => Effect.succeed(3000))
)

export const withFinalFallback = loadPort("invalid").pipe(
  // Catch a specific error with Effect.catchTag
  Effect.catchTag("ReservedPortError", (_) => Effect.succeed(3000)),
  // Catch all errors with Effect.catch
  Effect.catch((_) => Effect.succeed(3000))
)
```

### More examples

- **[Catch multiple errors with Effect.catchTags](./ai-docs/src/01_effect/03_errors/10_catch-tags.ts)**: Use `Effect.catchTags` to handle several tagged errors in one place.
- **[Creating and handling errors with reasons](./ai-docs/src/01_effect/03_errors/20_reason-errors.ts)**:
  Define a tagged error with a tagged `reason` field, then recover with
  `Effect.catchReason`, `Effect.catchReasons`, or by unwrapping the reason into
  the error channel with `Effect.unwrapReason`.

## Managing resources and `Scope`s

Learn how to safely manage resources in Effect using `Scope`s and finalizers.

- **[Acquiring resources with Effect.acquireRelease](./ai-docs/src/01_effect/04_resources/10_acquire-release.ts)**:
  Define a service that uses `Effect.acquireRelease` to manage the lifecycle of
  a resource, ensuring that it is properly cleaned up when the service is no
  longer needed.
- **[Creating Layers that run background tasks](./ai-docs/src/01_effect/04_resources/20_layer-side-effects.ts)**: Use Layer.effectDiscard to encapsulate background tasks without a service interface.
- **[Dynamic resources with LayerMap](./ai-docs/src/01_effect/04_resources/30_layer-map.ts)**:
  Use `LayerMap.Service` to dynamically build and manage resources that are
  keyed by some identifier, such as a tenant ID.

## Running Effect programs

- **[Running effects with NodeRuntime and BunRuntime](./ai-docs/src/01_effect/05_running/10_run-main.ts)**: Use `NodeRuntime.runMain` to run an Effect program as your process entrypoint.
- **[Using Layer.launch as the application entry point](./ai-docs/src/01_effect/05_running/20_layer-launch.ts)**: Use `Layer.launch` to run a long-running Effect program as your process entrypoint.

## Broadcasting messages with PubSub

Use `PubSub` when you need one producer to fan out messages to many consumers.

- **[Broadcasting domain events with PubSub](./ai-docs/src/01_effect/06_pubsub/10_pubsub.ts)**: Build an in-process event bus with `PubSub` and expose it as a service.

## Working with Streams

Effect Streams represent effectful, pull-based sequences of values over time.
They let you model finite or infinite data sources.

- **[Creating streams from common data sources](./ai-docs/src/02_stream/10_creating-streams.ts)**:
  Learn how to create streams from various data sources. Includes:
  
  - `Stream.fromIterable` for arrays and other iterables
  - `Stream.fromEffectSchedule` for polling effects
  - `Stream.paginate` for paginated APIs
  - `Stream.fromAsyncIterable` for async iterables
  - `Stream.fromEventListener` for DOM events
  - `Stream.callback` for any callback-based API
  - `NodeStream.fromReadable` for Node.js readable streams
- **[Consuming and transforming streams](./ai-docs/src/02_stream/20_consuming-streams.ts)**: How to transform and consume streams using operators like `map`, `flatMap`, `filter`, `mapEffect`, and various `run*` methods.
- **[Decoding and encoding streams](./ai-docs/src/02_stream/30_encoding.ts)**:
  Use `Stream.pipeThroughChannel` with the `Ndjson` & `Msgpack` modules to
  decode and encode streams of structured data.

## Integrating Effect into existing applications

`ManagedRuntime` bridges Effect programs with non-Effect code. Build one runtime
from your application Layer, then use it anywhere you need imperative execution,
like web handlers, framework hooks, worker queues, or legacy callback APIs.

- **[Using ManagedRuntime with Hono](./ai-docs/src/03_integration/10_managed-runtime.ts)**: Use `ManagedRuntime` to run Effect programs from external frameworks while keeping your domain logic in services and Layers.

## Batching external requests

Learn how to batch multiple requests into fewer external calls.

- **[Batching requests with RequestResolver](./ai-docs/src/05_batching/10_request-resolver.ts)**: Define request types with `Request.Class`, resolve them in batches with `RequestResolver`.

## Working with Schedules

Schedules define recurring patterns for retries, repeats and polling.

- **[Working with the Schedule module](./ai-docs/src/06_schedule/10_schedules.ts)**: Build schedules, compose them, and use them with `Effect.retry` and `Effect.repeat`.

## Observability

Effect has built-in support for structured logging, distributed tracing, and
metrics. For exporting telemetry, use the lightweight Otlp modules from
`effect/unstable/observability` in new projects, or use
`@effect/opentelemetry` NodeSdk when integrating with an existing OpenTelemetry
setup.

- **[Customizing logging](./ai-docs/src/08_observability/10_logging.ts)**: Configure loggers & log-level filtering for production applications.
- **[Setting up tracing with Otlp modules](./ai-docs/src/08_observability/20_otlp-tracing.ts)**: Configure Otlp tracing + log export with a reusable observability layer.

## Testing Effect programs

- **[Writing Effect tests with @effect/vitest](./ai-docs/src/09_testing/10_effect-tests.ts)**: Using `it.effect` for Effect-based tests.
- **[Testing services with shared layers](./ai-docs/src/09_testing/20_layer-tests.ts)**: How to test Effect services that depend on other services.

## Effect HttpClient

Build http clients with the `HttpClient` module.

- **[Getting started with HttpClient](./ai-docs/src/50_http-client/10_basics.ts)**: Define a service that uses the HttpClient module to fetch data from an external API

## Building HttpApi servers

`HttpApi` gives you schema-first, type-safe HTTP APIs with runtime validation, typed clients, and OpenAPI docs from one definition.

- **[Getting started with HttpApi](./ai-docs/src/51_http-server/10_basics.ts)**:
  Define a schema-first API, implement handlers, secure endpoints with
  middleware, serve it over HTTP, and call it using a generated typed client.

## Working with child processes

Use the `effect/unstable/process` modules to define child processes and run them with `ChildProcessSpawner.

- **[Working with child processes](./ai-docs/src/60_child-process/10_working-with-child-processes.ts)**: This example shows how to collect process output, compose pipelines, and stream long-running command output.

## Building CLI applications

Use the "effect/unstable/cli" modules to build CLI applications. These modules
provide utilities for parsing command-line arguments, handling user input, and
managing the flow of a CLI application.

- **[Getting started with Effect CLI modules](./ai-docs/src/70_cli/10_basics.ts)**:
  Build a command-line app with typed arguments and flags, then wire subcommand
  handlers into a single executable command.

## Working with AI modules

Effect's AI modules provide a provider-agnostic interface for language models.
You can generate text, decode structured objects with `Schema` and stream partial
responses.

- **[Using LanguageModel for text, objects, and streams](./ai-docs/src/71_ai/10_language-model.ts)**:
  Configure a provider once, then use `LanguageModel` for plain text
  generation, schema-validated object generation, and streaming responses.
- **[Defining and using AI tools](./ai-docs/src/71_ai/20_tools.ts)**:
  Define tools with schemas, group them into toolkits, implement handlers,
  and pass them to `LanguageModel.generateText`.
- **[Stateful chat sessions](./ai-docs/src/71_ai/30_chat.ts)**:
  The AI `Chat` module maintains conversation history automatically. Build
  AI agents or chat assistants.

## Building distributed applications with cluster

The cluster modules let you model stateful services as entities and distribute
them across multiple machines.

- **[Defining cluster entities](./ai-docs/src/80_cluster/10_entities.ts)**: Define distributed entity RPCs and run them in a cluster.