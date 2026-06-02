# Overview

The `HttpApi` modules let you describe your HTTP API once and use that description to run a server, generate documentation, and create a type-safe client.

An API is built from three building blocks:

- **HttpEndpoint** — a single route (path + HTTP method) with schemas for its request and response.
- **HttpApiGroup** — a collection of related endpoints (e.g., all user-related routes).
- **HttpApi** — the top-level object that combines groups into a complete API.

```
HttpApi
├── HttpGroup
│   ├── HttpEndpoint
│   └── HttpEndpoint
└── HttpGroup
    ├── HttpEndpoint
    ├── HttpEndpoint
    └── HttpEndpoint
```

From one API definition you can:

- **Start a server** that implements and serves every endpoint.
- **Generate documentation** (Scalar or Swagger) automatically.
- **Derive a client** with a typed method for each endpoint.

One definition powers the server, docs, and client — change it once and everything stays in sync.

# Getting Started

## Defining and Implementing an API

Let's build a minimal API with one endpoint that returns `"Hello, World!"`. You'll define what the endpoint looks like, implement it, and start a server.

```
HttpApi ("MyApi")
└── HttpGroup ("Greetings")
    └── HttpEndpoint ("hello-world")
```

**Example** (Hello World)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

// Definition
const Api = HttpApi.make("MyApi").add(
  // Define the API group
  HttpApiGroup.make("Greetings").add(
    // Define the endpoint
    HttpApiEndpoint.get("hello", "/", {
      // Define the success schema
      success: Schema.String
    })
  )
)

// Implementation
const GroupLive = HttpApiBuilder.group(
  Api,
  "Greetings", // The name of the group to handle
  (handlers) =>
    handlers.handle(
      "hello", // The name of the endpoint to handle
      () => Effect.succeed("Hello, World!") // The handler function
    )
)

// Server
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

// Launch
Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

After running the code, open a browser and navigate to http://localhost:3000. The server will respond with:

```
Hello, World!
```

## Serving The Auto Generated OpenAPI Documentation

Adding a documentation layer gives you an interactive page where you (and your API consumers) can explore endpoints, try requests, and see response shapes — all generated automatically from your API definition. You can choose between the `HttpApiScalar` module (Scalar UI) or the `HttpApiSwagger` module (Swagger UI); both do the same job.

**Example** (Serving Scalar Documentation)

To include Scalar in your server setup, provide the `HttpApiScalar.layer` when configuring the server.

```ts
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  // Provide the Scalar layer so clients can access auto-generated docs
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)
```

After running the server, open your browser and navigate to http://localhost:3000/docs.

This URL will display the Scalar documentation, allowing you to explore the API's endpoints, request parameters, and response structures interactively.

**Example** (Serving Swagger Documentation)

To include Swagger in your server setup, provide the `HttpApiSwagger.layer` when configuring the server.

```ts
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  // Provide the Swagger layer so clients can access auto-generated docs
  Layer.provide(HttpApiSwagger.layer(Api)), // "/docs" is the default path.
  // or Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)
```

After running the server, open your browser and navigate to http://localhost:3000/docs.

This URL will display the Swagger documentation, allowing you to explore the API's endpoints, request parameters, and response structures interactively.

## Adding Annotations to Schemas

Annotations attach extra information to your schemas — like a human-readable description or an identifier shown in the docs UI. They don't change runtime behavior; they enrich the generated documentation.

```ts
const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
}).annotate({
  description: "A user", // The description of the user
  identifier: "User" // Used in the Scalar UI under the Model section
})
```

## Deriving a Client

Once you've defined an API, you can generate a fully typed client from it using the `HttpApiClient` module. The client gives you a method for every endpoint, so calling your API feels like calling a local function — with full type safety and no manual HTTP handling.

**Example** (Deriving and Using a Client)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Greetings")
      .add(
        HttpApiEndpoint.get("hello", "/", {
          success: Schema.String
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Greetings",
  (handlers) => handlers.handle("hello", () => Effect.succeed("Hello, World!"))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// Create a program that derives and uses the client
const program = Effect.gen(function*() {
  // Derive the client
  const client = yield* HttpApiClient.make(Api, {
    baseUrl: "http://localhost:3000"
  })
  // Call the "hello-world" endpoint
  const hello = yield* client.Greetings.hello()
  console.log(hello)
})

// Provide a Fetch-based HTTP client and run the program
Effect.runFork(program.pipe(Effect.provide(FetchHttpClient.layer)))
/*
Output:
[18:55:26.051] INFO (#2): Listening on http://0.0.0.0:3000
[18:55:26.057] INFO (#12) http.span=2ms: Sent HTTP response { 'http.method': 'GET', 'http.url': '/', 'http.status': 200 }
Hello, World!
*/
```

# Design Principles

- **Schemas first**: Every piece of data flowing in or out of an endpoint — path params, query strings, headers, payloads, responses, and errors — is described by a schema. The framework uses these schemas to validate requests, serialize responses, generate docs, and type the client.
- **Metadata lives on schemas**: Configuration like HTTP status codes and content types is attached directly to the schema via annotations, not to the endpoint. This keeps all the information about a data shape in one place.

In particular:

- **Request**
  - **Payload encoding / content type** is controlled with `HttpApiSchema.as*` helpers:
    - `asJson` — parse the body as JSON (default)
    - `asFormUrlEncoded` — parse the body as URL-encoded form data
    - `asText` — parse the body as plain text
    - `asUint8Array` — parse the body as raw binary data
    - `asMultipart` — parse the body as a multipart form (for file uploads)
    - `asMultipartStream` — parse the body as a streaming multipart form
- **Response**
  - **Status code** is set via the `HttpApiSchema.status` API (or `httpApiStatus` annotation)
  - **Encoding / content type** is controlled with `HttpApiSchema.as*` helpers:
    - `asJson` — send the body as JSON (default)
    - `asFormUrlEncoded` — send the body as URL-encoded form data
    - `asText` — send the body as plain text
    - `asUint8Array` — send the body as raw binary data

## Anatomy of an Endpoint

An endpoint definition describes everything the framework needs to know about a single HTTP route: which URL parameters it expects, what query strings and headers it reads, what the request body looks like, and what it can respond with (both successes and errors). All of these are optional.

`HttpApiEndpoint` automatically coerces request and response schemas by default. Path / query / header schemas use `Schema.toCodecStringTree`, while JSON payload / success / error schemas use `Schema.toCodecJson`. This means you can define schemas in their natural domain types (for example `Schema.Int`), without manually adding string / JSON transformations.

```ts
const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})

//                     ┌─── Endpoint name (used in the client as the method name)
//                     │            ┌─── Endpoint path
//                     ▼            ▼
HttpApiEndpoint.patch("updateUser", "/user/:id", {
  // Parameters from the route pattern (e.g. /user/:id).
  // Can be a record of fields or a full schema.
  params: {
    //  ┌─── Schema for the "id" parameter.
    //  ▼
    id: Schema.String
  },

  // (optional) Query string parameters (e.g. ?mode=merge).
  // Can be a record of fields or a full schema.
  query: {
    //    ┌─── Schema for the "mode" query parameter
    //    ▼
    mode: Schema.Literals(["merge", "replace"])
  },

  // (optional) Request headers.
  // Can be a record of fields or a full schema.
  headers: {
    "x-api-key": Schema.String,
    "x-request-id": Schema.String
  },

  // The request payload can be a single schema or an array of schemas.
  // - Default encoding is JSON.
  // - Default status for success is 200.
  // For GET requests, the payload must be a record of schemas.
  payload: [
    // JSON payload (default encoding).
    Schema.Struct({
      name: Schema.String
    }),
    // text/plain payload.
    Schema.String.pipe(HttpApiSchema.asText())
  ],

  // Possible success responses.
  // Default is 200 OK with no content if omitted.
  success: [
    // JSON response (default encoding).
    User,
    // text/plain response with a custom status code.
    Schema.String
      .pipe(
        HttpApiSchema.status(206),
        HttpApiSchema.asText()
      )
  ],

  // Possible error responses.
  error: [
    // Default is 500 Internal Server Error with JSON encoding.
    Schema.Finite,

    // text/plain error with a custom status code.
    Schema.String
      .pipe(
        HttpApiSchema.status(404),
        HttpApiSchema.asText()
      ),

    // Any schema that encodes to `Schema.Void` is treated as "no content".
    // Here it uses a custom status code.
    Schema.Void
      .pipe(HttpApiSchema.status(401))
  ]
})
```

# Routing

This section walks through defining endpoints for common HTTP methods — GET, POST, DELETE, and PATCH — using a user-management API as a running example:

- `GET /users` — retrieve all users.
- `GET /users/:userId` — retrieve a specific user by ID.
- `POST /users` — create a new user.
- `DELETE /users/:userId` — delete a user by ID.
- `PATCH /users/:userId` — update a user by ID.

## GET

Use `HttpApiEndpoint.get` to create a GET endpoint. Provide a name (used as the method name in generated clients), a path, and optionally a `success` schema describing what the endpoint returns. Without a success schema the default response is `204 No Content`.

**Example** (Defining a GET Endpoint to Retrieve All Users)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

// Define a schema representing a User entity
const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        // Define the "getUsers" endpoint, returning a list of users
        //                   ┌─── Endpoint name (used in the client as the method name)
        //                   │            ┌─── Endpoint path
        //                   ▼            ▼
        HttpApiEndpoint.get("getUsers", "/users", {
          //                   ┌─── success schema
          //                   │
          //                   ▼
          success: Schema.Array(User)
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers.handle("getUsers", () =>
      Effect.succeed(
        [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
      ))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## POST

Use `HttpApiEndpoint.post` to create an endpoint that accepts data. The `payload` option describes the shape of the request body, and `success` describes what the endpoint returns.

**Example** (Defining a POST Endpoint with Payload and Success Schemas)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
        }),
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: Schema.Int
          },
          success: User
        }),
        // Define a POST endpoint for creating a new user
        HttpApiEndpoint.post("createUser", "/user", {
          // Define the request body schema (payload)
          payload: User,
          // Define the schema for a successful response
          success: User
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () =>
        Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        ))
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("createUser", (ctx) => {
        //    ┌─── User
        //    ▼
        const user = ctx.payload
        return Effect.succeed(user)
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## DELETE

Use `HttpApiEndpoint.delete` to create an endpoint that removes a resource.

**Example** (Defining a DELETE Endpoint with Parameters)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const IdParam = Schema.Int

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
        }),
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: IdParam
          },
          success: User
        }),
        HttpApiEndpoint.post("createUser", "/user", {
          payload: User,
          success: User
        }),
        HttpApiEndpoint.delete("deleteUser", "/user/:id", {
          params: {
            id: IdParam
          }
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () =>
        Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        ))
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("createUser", (ctx) => {
        const user = ctx.payload
        return Effect.succeed(user)
      })
      .handle("deleteUser", (ctx) => {
        const id = ctx.params.id
        return Effect.log(`Deleting user ${id}`)
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## PATCH

Use `HttpApiEndpoint.patch` to create an endpoint that partially updates a resource. Like POST, you can define `payload` (the fields to update) and `success` (the response after the update).

**Example** (Defining a PATCH Endpoint for Updating a User)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const IdParam = Schema.Int

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
        }),
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: IdParam
          },
          success: User
        }),
        HttpApiEndpoint.post("createUser", "/user", {
          payload: User,
          success: User
        }),
        HttpApiEndpoint.delete("deleteUser", "/user/:id", {
          params: {
            id: IdParam
          }
        }),
        HttpApiEndpoint.patch("updateUser", "/user/:id", {
          params: {
            id: IdParam
          },
          // Specify the schema for the request payload
          payload: Schema.Struct({
            name: Schema.String // Only the name can be updated
          }),
          // Specify the schema for a successful response
          success: User
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () =>
        Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        ))
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("createUser", (ctx) => {
        const user = ctx.payload
        return Effect.succeed(user)
      })
      .handle("deleteUser", (ctx) => {
        const id = ctx.params.id
        return Effect.log(`Deleting user ${id}`)
      })
      .handle("updateUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## Parameters

Path parameters let you capture dynamic values from the URL. For example, `/user/:id` extracts the `id` segment. Use the `params` option to declare a record of fields or a full schema — the framework will parse and validate the value before your handler runs.

**Example** (Defining a GET Endpoint to Retrieve a User by ID)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
        }),
        // a GET endpoint with a parameter ":id"
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            //  ┌─── schema for the "id" parameter
            //  ▼
            id: Schema.Int
          },
          success: User
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () =>
        Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        ))
      .handle("getUser", (ctx) => {
        //    ┌─── number
        //    ▼
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## Catch-All Endpoints

Set the path to `"*"` to match any URL that no other endpoint handles. This is useful for custom "not found" pages or fallback responses.

**Example** (Defining a Catch-All Endpoint)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const IdParam = Schema.Int

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
        }),
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: IdParam
          },
          success: User
        }),
        HttpApiEndpoint.post("createUser", "/user", {
          payload: User,
          success: User
        }),
        HttpApiEndpoint.delete("deleteUser", "/user/:id", {
          params: {
            id: IdParam
          }
        }),
        HttpApiEndpoint.patch("updateUser", "/user/:id", {
          params: {
            id: IdParam
          },
          payload: Schema.Struct({
            name: Schema.String
          }),
          success: User
        }),
        // catch-all endpoint
        HttpApiEndpoint.get("catchAll", "*", {
          success: Schema.String
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () =>
        Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        ))
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("createUser", (ctx) => {
        const user = ctx.payload
        return Effect.succeed(user)
      })
      .handle("deleteUser", (ctx) => {
        const id = ctx.params.id
        return Effect.log(`Deleting user ${id}`)
      })
      .handle("updateUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("catchAll", () => {
        return Effect.succeed("Not found")
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

> [!IMPORTANT]
> The catch-all endpoint must be the last endpoint in the group.

> [!IMPORTANT]
> (OpenAPI). A catch-all endpoint is not included in the OpenAPI specification because can't be represented as a path.

## Prefixing

Prefixes let you prepend a common path segment to endpoints, groups, or an entire API. This avoids repeating the same base path on every endpoint.

**Example** (Using Prefixes for Common Path Management)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("group")
      .add(
        HttpApiEndpoint.get("endpointA", "/a", {
          success: Schema.String
        })
          // Prefix for this endpoint
          .prefix("/endpointPrefix"),
        HttpApiEndpoint.get("endpointB", "/b", {
          success: Schema.String
        })
      )
      // Prefix for all endpoints in the group
      .prefix("/groupPrefix")
  )
  // Prefix for the entire API
  .prefix("/apiPrefix")

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers
      .handle("endpointA", () => Effect.succeed("Endpoint A"))
      .handle("endpointB", () => Effect.succeed("Endpoint B"))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test this endpoint using a GET request. For example:

```sh
curl http://localhost:3000/apiPrefix/groupPrefix/endpointPrefix/a # Returns 200 OK
curl http://localhost:3000/apiPrefix/groupPrefix/b # Returns 200 OK
```

# Request

## Query Parameters

Query parameters are the `?key=value` pairs appended to a URL. Use the `query` option to declare a record of fields or a full schema — the framework will parse, validate, and type them for you.

**Example** (Defining Query Parameters with Metadata)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Page = Schema.Int.check(Schema.isGreaterThan(0))

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User),
          // Specify a schema for each query parameter
          query: {
            // Parameter "page" for pagination
            page: Schema.optionalKey(Page),
            // Parameter "sort" for sorting options
            sort: Schema.optionalKey(Schema.Literals(["id", "name"]))
          }
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", (ctx) => {
        const { page, sort } = ctx.query
        console.log(`Getting users with page ${page} and sort ${sort}`)
        return Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        )
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

#### Defining an Array of Values for a Query Parameter

A single query parameter can carry multiple values (e.g., `?a=1&a=2`). Wrap the parameter's schema in `Schema.Array` to accept an array of values.

**Example** (Defining an Array of String Values for a Query Parameter)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User),
          query: {
            a: Schema.optionalKey(Schema.Array(Schema.String))
          }
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", (ctx) => {
        console.log(ctx.query)
        return Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        )
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test this endpoint by passing an array of values in the query string. For example:

```sh
curl "http://localhost:3000/users?a=1&a=2" # Two values for the `a` parameter
```

The query string sends two values (`1` and `2`) for the `a` parameter. The server will process and validate these values according to the schema.

Both the following requests will be valid:

```sh
curl "http://localhost:3000/users" # No values for the `a` parameter
curl "http://localhost:3000/users?a=1" # One value for the `a` parameter
```

## Request Headers

Use the `headers` option to declare a record of fields or a full schema for the request headers the endpoint expects.

> [!IMPORTANT]
> All headers are normalized to lowercase. Always use lowercase keys for the headers.

**Example** (Describe and validate custom headers)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          // Always use lowercase keys for the headers
          headers: {
            "x-api-key": Schema.String,
            "x-request-id": Schema.String
          },
          success: Schema.Array(User)
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers.handle("getUsers", () =>
      Effect.succeed(
        [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
      ))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test the endpoint by sending the headers:

```sh
curl -H "X-API-Key: 1234567890" -H "X-Request-ID: 1234567890" http://localhost:3000/users
```

The server validates these headers against the declared schema before handling the request.

## Handling Multipart Requests

To accept file uploads, mark the payload as multipart with `HttpApiSchema.asMultipart`. Use `Multipart.FilesSchema` for the file fields — uploaded files will be persisted to disk automatically.

**Example** (Defining an Endpoint for File Uploads)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, Multipart } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.post("upload", "/users/upload", {
          // Specify that the payload is a multipart request
          payload: HttpApiSchema.asMultipart(
            Schema.Struct({
              // Define a "files" field to handle file uploads
              files: Multipart.FilesSchema
            })
          ),
          success: Schema.String
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("upload", (ctx) => {
        //      ┌─── readonly Multipart.PersistedFile[]
        //      ▼
        const { files } = ctx.payload
        console.log(files)
        return Effect.succeed("Uploaded")
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test this endpoint by sending a multipart request with a file upload. For example:

```sh
echo "Sample file content" | curl -X POST -F "files=@-" http://localhost:3000/users/upload
```

## Changing the Request Encoding

By default, request bodies are JSON. To accept a different format — like form-urlencoded data — pipe the payload schema through the appropriate `HttpApiSchema.as*` helper.

**Example** (Customizing Request Encoding)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.post("createUser", "/user", {
          // Set the request payload as a string encoded with query parameters
          payload: Schema.Struct({
            id: Schema.Int,
            name: Schema.String
          })
            // Specify the encoding as form url encoded
            .pipe(HttpApiSchema.asFormUrlEncoded()),
          success: User
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("createUser", (ctx) => {
        const user = ctx.payload
        return Effect.succeed(user)
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test this endpoint using a URL-encoded request body. For example:

```sh
curl http://localhost:3000/user \
  --request POST \
  --header 'Accept: */*' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'id=1' \
  --data-urlencode 'name=John'
```

## Accessing the HttpServerRequest

Inside a handler, `ctx.request` gives you access to the raw incoming HTTP request. Use this when you need low-level details not covered by the endpoint schema (e.g., the HTTP method or raw URL).

**Example** (Accessing the Request Object in a GET Endpoint)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi").add(
  HttpApiGroup.make("Greetings").add(
    HttpApiEndpoint.get("hello", "/", {
      success: Schema.String
    })
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "Greetings",
  (handlers) =>
    handlers.handle(
      "hello",
      (ctx) => {
        //     ┌─── HttpServerRequest
        //     ▼
        const req = ctx.request
        // Access the request method
        console.log(req.method)
        return Effect.succeed("Hello, World!")
      }
    )
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## Validating Request Cookies

There is no `cookies` option on endpoints. Instead, validated cookie access goes through the security middleware system: define an `HttpApiSecurity.apiKey` with `in: "cookie"` and attach it to a middleware. The cookie value is decoded and handed to your security handler as a `Redacted` credential.

**Example** (Validating a Session Cookie)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiScalar,
  HttpApiSecurity
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

// Define the service providing the current user
class CurrentUser
  extends Context.Service<CurrentUser, { readonly id: number; readonly name: string }>()("CurrentUser")
{}

// Define the security scheme: read the "session" cookie
const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "session" })

class Auth extends HttpApiMiddleware.Service<Auth, {
  provides: CurrentUser
}>()("Auth", {
  error: Schema.String.annotate({
    httpApiStatus: 401,
    description: "Auth error"
  }),
  security: { session: sessionCookie }
}) {}

const Api = HttpApi.make("api").add(
  HttpApiGroup.make("group")
    .add(
      HttpApiEndpoint.get("me", "/me", {
        success: Schema.Struct({ id: Schema.Finite })
      })
    )
    .middleware(Auth)
)

const AuthLive = Layer.succeed(
  Auth,
  {
    session: (effect, opts) =>
      Effect.provideServiceEffect(
        effect,
        CurrentUser,
        Effect.gen(function*() {
          const value = Redacted.value(opts.credential)
          if (value !== "valid-session") {
            return yield* Effect.fail("Invalid session")
          }
          return { id: 1, name: "John Doe" }
        })
      )
  }
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle("me", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        return { id: user.id }
      }))
).pipe(Layer.provide(AuthLive))

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// Valid session:
// curl "http://localhost:3000/me" --cookie "session=valid-session"
// {"id":1}
//
// Invalid session:
// curl "http://localhost:3000/me" --cookie "session=wrong"
// "Invalid session"
```

For quick, unvalidated access you can read cookies directly from `ctx.request.cookies` inside any handler. These cookies won't appear in the OpenAPI spec.

**Example** (Reading Cookies Directly in a Handler)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("api").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("me", "/me", {
      success: Schema.String
    })
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle("me", (ctx) => {
      const lang = ctx.request.cookies.lang ?? "en"
      return Effect.succeed(`Language: ${lang}`)
    })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// curl "http://localhost:3000/me" --cookie "lang=it"
// "Language: it"
```

## Streaming Requests

To receive large or continuous data from the client, define the payload as a `Uint8Array` and pipe it through `HttpApiSchema.asUint8Array()`. The handler receives the raw bytes, which you can decode as needed.

**Example** (Handling Streaming Requests)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("myApi").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.post("acceptStream", "/stream", {
      // Define the payload as a Uint8Array with a specific encoding
      payload: Schema.Uint8Array.pipe(
        HttpApiSchema.asUint8Array() // default content type: application/octet-stream
      ),
      success: Schema.String
    })
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle(
      "acceptStream",
      (ctx) => {
        // Decode the incoming binary data into a string
        return Effect.succeed(new TextDecoder().decode(ctx.payload))
      }
    )
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test the streaming request using `curl` or any tool that supports sending binary data. For example:

```sh
echo "abc" | curl -X POST 'http://localhost:3000/stream' --data-binary @- -H "Content-Type: application/octet-stream"
# Output: abc
```

# Response

## Status Codes

Success responses default to `200 OK`. To use a different status code, annotate the success schema with `HttpApiSchema.status(code)` or set the `httpApiStatus` annotation.

**Example** (Defining a GET Endpoint with a custom status code)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
            .pipe(HttpApiSchema.status(206))
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () => {
        return Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        )
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## Changing the Response Encoding

Responses default to JSON. To return a different format — like CSV or plain text — pipe the success schema through the matching `HttpApiSchema.as*` helper and, optionally, set a custom `contentType`.

**Example** (Returning Data as `text/csv`)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("csv", "/users/csv", {
          success: Schema.String.pipe(
            // Set the success response as a string with CSV encoding
            HttpApiSchema.asText({
              // Define the content type as text/csv
              contentType: "text/csv"
            })
          )
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("csv", (ctx) => {
        return Effect.succeed("id,name\n1,John\n2,Jane")
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test this endpoint using a GET request. For example:

```sh
curl http://localhost:3000/users/csv
```

The following encodings are supported:

- `Json` the default encoding (default content type: `application/json`)
- `Uint8Array` the encoding for binary data (default content type: `application/octet-stream`)
- `Text` the encoding for text data (default content type: `text/plain`)

## Setting Response Headers

To add custom headers to the outgoing response, call `HttpEffect.appendPreResponseHandler` inside your handler. The callback receives the request and response objects and must return the updated response.

**Example** (Adding a Custom Response Header)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("api").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("hello", "/hello", {
      success: Schema.String
    })
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle("hello", () =>
      Effect.gen(function*() {
        yield* HttpEffect.appendPreResponseHandler((_req, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "x-custom", "hello"))
        )
        return "Hello, World!"
      }))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// curl -v "http://localhost:3000/hello" 2>&1 | grep -i "x-custom"
// < x-custom: hello
```

## Setting Response Cookies

Set cookies on the response using `HttpEffect.appendPreResponseHandler` together with `HttpServerResponse.setCookie`. For cookies tied to an `HttpApiSecurity.apiKey`, use the shortcut `HttpApiBuilder.securitySetCookie` instead.

**Example** (Setting a Response Cookie)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("api").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("hello", "/hello", {
      success: Schema.String
    })
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle("hello", () =>
      Effect.gen(function*() {
        yield* HttpEffect.appendPreResponseHandler((_req, response) =>
          Effect.succeed(HttpServerResponse.setCookieUnsafe(response, "my-cookie", "my-value", {
            httpOnly: true,
            secure: true,
            path: "/"
          }))
        )
        return "Hello, World!"
      }))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// curl -v "http://localhost:3000/hello" 2>&1 | grep -i "set-cookie"
// < set-cookie: my-cookie=my-value; Path=/; HttpOnly; Secure
```

## Redirects

To redirect the client to a different URL, return an `HttpServerResponse.redirect` from the handler. The redirect is not modeled in the schema — the endpoint definition stays as "no content".

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("newPage", "/new", {
      success: Schema.String
    }),
    // Schema-wise this is just "no content" (redirect headers aren't modeled here)
    HttpApiEndpoint.get("oldPage", "/old")
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers
      .handle("newPage", () => Effect.succeed("You are on /new"))
      .handle("oldPage", () =>
        Effect.succeed(
          HttpServerResponse.redirect("/new", { status: 302 })
        ))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// curl "http://localhost:3000/old" -L
```

## Streaming Responses

To stream data to the client over time, return an `HttpServerResponse.stream` from the handler. The stream emits chunks at whatever pace you choose.

**Example** (Implementing a Streaming Endpoint)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schedule, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("myApi").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("getStream", "/stream", {
      success: Schema.String.pipe(
        HttpApiSchema.asText({
          contentType: "application/octet-stream"
        })
      )
    })
  )
)

// Simulate a stream of data
const stream = Stream.make("a", "b", "c").pipe(
  Stream.schedule(Schedule.spaced("500 millis")),
  Stream.map((s) => new TextEncoder().encode(s))
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle(
      "getStream",
      () => Effect.succeed(HttpServerResponse.stream(stream))
    )
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test the streaming response using `curl` or any similar HTTP client that supports streaming:

```sh
curl 'http://localhost:3000/stream' --no-buffer
```

The response will stream data (`a`, `b`, `c`) with a 500ms interval between each item.

# Error Handling

## Adding Custom Error Responses

Endpoints can declare the errors they may return. Each error is a schema annotated with an HTTP status code via `HttpApiSchema.status(code)`. The status is set once on the schema and reused wherever that schema appears. When your handler fails with a matching error, the framework serializes it and responds with the declared status.

**Example** (Defining Error Responses for an Endpoint)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const UserNotFound = Schema.Struct({
  _tag: Schema.tag("UserNotFound"),
  message: Schema.String
}).pipe(HttpApiSchema.status(404))

const Unauthorized = Schema.Struct({
  _tag: Schema.tag("Unauthorized")
}).pipe(HttpApiSchema.status(401))

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: Schema.Int
          },
          success: User,
          error: [UserNotFound, Unauthorized /** etc. */]
        })
      )
      .add(
        HttpApiEndpoint.delete("deleteUser", "/user/:id", {
          params: {
            id: Schema.Int
          },
          error: [UserNotFound, Unauthorized /** etc. */]
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        if (id === 1) {
          return Effect.fail(UserNotFound.make({ message: "User not found" }))
        }
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("deleteUser", (ctx) => {
        const id = ctx.params.id
        if (id === 1) {
          return Effect.fail(UserNotFound.make({ message: "User not found" }))
        }
        return Effect.succeed(void 0)
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

You can test these endpoints. For example:

```sh
curl http://localhost:3000/user/1              # Returns 404 Not Found
curl http://localhost:3000/user/2              # Returns 200 OK
curl -X DELETE http://localhost:3000/user/1    # Returns 404 Not Found
curl -X DELETE http://localhost:3000/user/2    # Returns 200 OK
```

## Predefined Error Types

The `HttpApiError` module provides ready-made error schemas for common HTTP status codes (404, 401, etc.). Using these saves you from defining boilerplate error types and keeps error handling consistent across your API.

**Example** (Adding a Predefined Error to an Endpoint)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiScalar
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: Schema.Int
          },
          success: User,
          error: [
            // Add a 404 error JSON response for this endpoint
            HttpApiError.NotFound,
            // Add a 401 error JSON response for unauthorized access
            HttpApiError.Unauthorized
          ]
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        if (id === 1) {
          return Effect.fail(new HttpApiError.NotFound({}))
        }
        return Effect.succeed({ id, name: `User ${id}` })
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

| Name                  | Status | Description                                                                                        |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `HttpApiDecodeError`  | 400    | Represents an error where the request did not match the expected schema. Includes detailed issues. |
| `BadRequest`          | 400    | Indicates that the request was malformed or invalid.                                               |
| `Unauthorized`        | 401    | Indicates that authentication is required but missing or invalid.                                  |
| `Forbidden`           | 403    | Indicates that the client does not have permission to access the requested resource.               |
| `NotFound`            | 404    | Indicates that the requested resource could not be found.                                          |
| `MethodNotAllowed`    | 405    | Indicates that the HTTP method used is not allowed for the requested resource.                     |
| `NotAcceptable`       | 406    | Indicates that the requested resource cannot be delivered in a format acceptable to the client.    |
| `RequestTimeout`      | 408    | Indicates that the server timed out waiting for the client request.                                |
| `Conflict`            | 409    | Indicates a conflict in the request, such as conflicting data.                                     |
| `Gone`                | 410    | Indicates that the requested resource is no longer available and will not return.                  |
| `InternalServerError` | 500    | Indicates an unexpected server error occurred.                                                     |
| `NotImplemented`      | 501    | Indicates that the requested functionality is not implemented on the server.                       |
| `ServiceUnavailable`  | 503    | Indicates that the server is temporarily unavailable, often due to maintenance or overload.        |

#### Predefined NoContent Error Types

Each predefined error also has a `NoContent` variant that responds with the status code but no body.

**Example** (Using a Predefined NoContent Error Type)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiScalar
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: Schema.Int
          },
          success: User,
          error: [
            // Add a 404 error no-content response for this endpoint
            HttpApiError.NotFoundNoContent,
            // Add a 401 error no-content response for unauthorized access
            HttpApiError.UnauthorizedNoContent
          ]
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        if (id === 1) {
          return Effect.fail(new HttpApiError.NotFound({}))
        }
        return Effect.succeed({ id, name: `User ${id}` })
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

## Customizing Schema Error Responses

By default, when a request fails schema validation (e.g., an invalid query parameter or a malformed path parameter), the framework responds with an empty `400 Bad Request`. If you want to replace that response with a custom error, use `HttpApiMiddleware.layerSchemaErrorTransform`.

This function creates a [middleware](#middlewares) layer that intercepts any `SchemaError` thrown during request decoding and lets you return your own error instead.

**Example** (Returning a Custom Error on Validation Failure)

In this example, if a client sends a non-integer `id` query parameter, the API responds with a `422` status and a JSON body describing the problem, instead of the default empty `400`.

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

// Define a custom error for validation failures
class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "ValidationError",
  {
    message: Schema.String
  }
) {}

// Define the middleware service, declaring the error it can produce
class SchemaErrorHandler extends HttpApiMiddleware.Service<SchemaErrorHandler>()(
  "api/SchemaErrorHandler",
  {
    error: ValidationError.pipe(HttpApiSchema.status(422))
  }
) {}

// Implement the middleware layer
const SchemaErrorHandlerLive = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrorHandler,
  (schemaError) =>
    Effect.fail(
      new ValidationError({
        message: `Invalid request: ${schemaError.message}`
      })
    )
)

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const Api = HttpApi.make("MyApi").add(
  HttpApiGroup.make("Users").add(
    HttpApiEndpoint.get("getUser", "/user", {
      query: {
        id: Schema.Int
      },
      success: User
    })
      // Attach the middleware to this endpoint only
      .middleware(SchemaErrorHandler)
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) => handlers.handle("getUser", (ctx) => Effect.succeed({ id: ctx.query.id, name: `User ${ctx.query.id}` }))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(SchemaErrorHandlerLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// Test:
// curl "http://localhost:3000/user?id=1"    # 200 OK
// curl "http://localhost:3000/user?id=abc"  # 422 with ValidationError JSON
```

The middleware can be attached at different scopes:

- **Endpoint**: `.middleware(SchemaErrorHandler)` on a single endpoint (as shown above).
- **Group**: `.middleware(SchemaErrorHandler)` on a group to cover all its endpoints.
- **API**: `.middleware(SchemaErrorHandler)` on the API to cover every endpoint.

# Middlewares

Middleware lets you run shared logic — like logging or authentication — before (or around) your handlers. Define a middleware as a class extending `HttpApiMiddleware.Service`, implement it as a `Layer`, and attach it to an endpoint, a group, or the entire API.

**Example** (Defining a Logger Middleware)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiScalar,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { createServer } from "node:http"

class Logger extends HttpApiMiddleware.Service<Logger>()("Http/Logger", {
  // default is 500 Internal Server Error with JSON encoding
  error: Schema.String
    .pipe(
      HttpApiSchema.status(405), // override default status code
      HttpApiSchema.asText() // override default encoding
    )
}) {}

const User = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String
})

const Api = HttpApi.make("api").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("getUser", "/user/:id", {
      params: {
        id: Schema.Int
      },
      success: User
    })
      // Apply the middleware to a single endpoint
      .middleware(Logger)
  )
    // Or apply the middleware to the entire group
    .middleware(Logger)
)
const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) =>
    handlers.handle("getUser", (ctx) => {
      const id = ctx.params.id
      return Effect.succeed({ id, name: `User ${id}` })
    })
)

const LoggerLive = Layer.effect(
  Logger,
  Effect.gen(function*() {
    yield* Effect.log("creating Logger middleware")

    return (res) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* Effect.log(`Request: ${request.method} ${request.url}`)
        return yield* res
      })
  })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  Layer.provide(LoggerLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// Test this with this curl command:
// curl "http://localhost:3000/user/1"
```

# Security

The `HttpApiSecurity` module lets you declare how an endpoint is protected. These declarations show up in the generated OpenAPI spec and are enforced at runtime through middleware.

Supported authorization types:

| Authorization Type       | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `HttpApiSecurity.apiKey` | API key authorization via headers, query parameters, or cookies. |
| `HttpApiSecurity.basic`  | HTTP Basic authentication.                                       |
| `HttpApiSecurity.bearer` | Bearer token authentication.                                     |

Attach a security scheme to an endpoint, group, or the entire API via `HttpApiMiddleware`.

**Example** (Defining Security Middleware)

```ts
import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"

// Define a schema for the "User"
class User extends Schema.Class<User>("User")({ id: Schema.Finite }) {}

// Define a schema for the "Unauthorized" error
class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {},
  // Specify the HTTP status code for unauthorized errors
  { httpApiStatus: 401 }
) {}

// Define a Context.Tag for the authenticated user
class CurrentUser extends Context.Service<CurrentUser, User>()("CurrentUser") {}

// Create the Authorization middleware
class Authorization extends HttpApiMiddleware.Service<Authorization, {
  // Specify the resource this middleware will provide
  provides: CurrentUser
}>()(
  "Authorization",
  {
    // Define the error schema for unauthorized access
    error: Unauthorized,
    // Add security definitions
    security: {
      // ┌─── Custom name for the security definition
      // ▼
      myBearer: HttpApiSecurity.bearer
      // Additional security definitions can be added here.
      // They will attempt to be resolved in the order they are defined.
    }
  }
) {}

const api = HttpApi.make("api")
  .add(
    HttpApiGroup.make("group")
      .add(
        HttpApiEndpoint.get("get", "/", {
          success: Schema.String
        })
          // Apply the middleware to a single endpoint
          .middleware(Authorization)
      )
      // Or apply the middleware to the entire group
      .middleware(Authorization)
  )
  // Or apply the middleware to the entire API
  .middleware(Authorization)
```

## Implementing HttpApiSecurity middleware

To enforce a security scheme, implement its middleware as a `Layer`. The layer returns an object with a handler for each security definition. Each handler receives the credential (e.g., a Bearer token as a `Redacted` value) and must return the resource the middleware provides (e.g., the current user).

**Example** (Implementing Bearer Token Authentication Middleware)

```ts
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"

class User extends Schema.Class<User>("User")({ id: Schema.Finite }) {}

class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {},
  // Specify the HTTP status code for unauthorized errors
  { httpApiStatus: 401 }
) {}

class CurrentUser extends Context.Service<CurrentUser, User>()("CurrentUser") {}

class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser
}>()(
  "Authorization",
  {
    error: Unauthorized,
    security: {
      myBearer: HttpApiSecurity.bearer
    }
  }
) {}

const AuthorizationLive = Layer.succeed(
  Authorization,
  // Return the security handlers for the middleware
  {
    // Define the handler for the Bearer token
    // The Bearer token is redacted for security
    myBearer: (effect, opts) =>
      Effect.provideServiceEffect(
        effect,
        CurrentUser,
        Effect.gen(function*() {
          yield* Effect.log(
            "checking bearer token",
            Redacted.value(opts.credential)
          )
          // Return a mock User object as the CurrentUser
          return new User({ id: 1 })
        })
      )
  }
)
```

## Adding Descriptions to Security Definitions

Use `HttpApiSecurity.annotate` to attach metadata — like a description — to a security definition. This metadata appears in the generated docs.

**Example** (Adding a Description to a Bearer Token Security Definition)

```ts
import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi"

class User extends Schema.Class<User>("User")({ id: Schema.Finite }) {}

class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {},
  // Specify the HTTP status code for unauthorized errors
  { httpApiStatus: 401 }
) {}

class CurrentUser extends Context.Service<CurrentUser, User>()("CurrentUser") {}

class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser
}>()(
  "Authorization",
  {
    error: Unauthorized,
    security: {
      myBearer: HttpApiSecurity.bearer.pipe(
        // Add a description to the security definition
        HttpApiSecurity.annotate(OpenApi.Description, "my description")
      )
    }
  }
) {}
```

## Setting HttpApiSecurity cookies

Use `HttpApiBuilder.securitySetCookie` to set a security cookie from a handler. The cookie is created with `HttpOnly` and `Secure` flags by default.

**Example** (Setting a Security Cookie in a Login Handler)

```ts
import { Redacted, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSecurity } from "effect/unstable/httpapi"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("login", "/login", {
          params: {
            success: Schema.String
          }
        })
      )
  )

// Define the security configuration for an API key stored in a cookie
const security = HttpApiSecurity.apiKey({
  // Specify that the API key is stored in a cookie
  in: "cookie",
  // Define the cookie name,
  key: "token"
})

const UsersApiLive = HttpApiBuilder.group(Api, "Users", (handlers) =>
  handlers.handle("login", () =>
    // Set the security cookie with a redacted value
    HttpApiBuilder.securitySetCookie(security, Redacted.make("keep me secret"))))
```

# Using Services Inside a HttpApiEndpoint

Handlers can access any Effect service. Because `HttpApiBuilder.group` returns an `Effect`, you can `yield*` services directly inside your handler logic.

**Example** (Using Services in a Endpoint Implementation)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

// Define the UsersRepository service
class UsersRepository extends Context.Service<UsersRepository, {
  readonly findById: (id: number) => Effect.Effect<typeof User.Type>
}>()("UsersRepository") {}

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: Schema.Int
          },
          success: User
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        return Effect.gen(function*() {
          // Access the UsersRepository service
          const repository = yield* UsersRepository
          return yield* repository.findById(id)
        })
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  Layer.provide(
    Layer.succeed(UsersRepository, {
      findById: (id) => Effect.succeed({ id, name: `User ${id}` })
    })
  ),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

# OpenAPI Documentation

Add interactive API documentation with `HttpApiScalar` (Scalar UI) or `HttpApiSwagger` (Swagger UI). Both read your API definition and generate a browsable docs page at `/docs`.

**Example** (Adding Scalar Documentation to an API)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const User = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const IdParam = Schema.Int

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Users")
      .add(
        HttpApiEndpoint.get("getUsers", "/users", {
          success: Schema.Array(User)
        }),
        HttpApiEndpoint.get("getUser", "/user/:id", {
          params: {
            id: IdParam
          },
          success: User
        }),
        HttpApiEndpoint.post("createUser", "/user", {
          payload: User,
          success: User
        }),
        HttpApiEndpoint.delete("deleteUser", "/user/:id", {
          params: {
            id: IdParam
          }
        }),
        HttpApiEndpoint.patch("updateUser", "/user/:id", {
          params: {
            id: IdParam
          },
          // Specify the schema for the request payload
          payload: Schema.Struct({
            name: Schema.String // Only the name can be updated
          }),
          // Specify the schema for a successful response
          success: User
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Users",
  (handlers) =>
    handlers
      .handle("getUsers", () =>
        Effect.succeed(
          [{ id: 1, name: "User 1" }, { id: 2, name: "User 2" }]
        ))
      .handle("getUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
      .handle("createUser", (ctx) => {
        const user = ctx.payload
        return Effect.succeed(user)
      })
      .handle("deleteUser", (ctx) => {
        const id = ctx.params.id
        return Effect.log(`Deleting user ${id}`)
      })
      .handle("updateUser", (ctx) => {
        const id = ctx.params.id
        return Effect.succeed({ id, name: `User ${id}` })
      })
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)), // "/docs" is the default path.
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)
```

After running the server, open your browser and navigate to http://localhost:3000/docs.

This URL will display the Scalar documentation, allowing you to explore the API's endpoints, request parameters, and response structures interactively.

## Adding OpenAPI Annotations

Annotations let you enrich the generated OpenAPI spec with titles, descriptions, server URLs, and more. They are added via the `.annotate` method on `HttpApi`, `HttpApiGroup`, or `HttpApiEndpoint`.

#### HttpApi

Below is a list of available annotations for a top-level `HttpApi`. They can be added using the `.annotate` method:

| Annotation                  | Description                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `HttpApi.AdditionalSchemas` | Adds custom schemas to the final OpenAPI specification. Only schemas with an `identifier` annotation are included. |
| `OpenApi.Description`       | Sets a general description for the API.                                                                            |
| `OpenApi.Title`             | Sets the title of the API.                                                                                         |
| `OpenApi.Version`           | Sets the version of the API.                                                                                       |
| `OpenApi.License`           | Defines the license used by the API.                                                                               |
| `OpenApi.Summary`           | Provides a brief summary of the API.                                                                               |
| `OpenApi.Servers`           | Lists server URLs and optional metadata such as variables.                                                         |
| `OpenApi.Override`          | Merges the supplied fields into the resulting specification.                                                       |
| `OpenApi.Transform`         | Allows you to modify the final specification with a custom function.                                               |

**Example** (Annotating the Top-Level API)

```ts
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"

const api = HttpApi.make("api")
  // Provide additional schemas
  .annotate(HttpApi.AdditionalSchemas, [
    Schema.String.annotate({ identifier: "MyString" })
  ])
  // Add a description
  .annotate(OpenApi.Description, "my description")
  // Set license information
  .annotate(OpenApi.License, { name: "MIT", url: "http://example.com" })
  // Provide a summary
  .annotate(OpenApi.Summary, "my summary")
  // Define servers
  .annotate(OpenApi.Servers, [
    {
      url: "http://example.com",
      description: "example",
      variables: { a: { default: "b", enum: ["c"], description: "d" } }
    }
  ])
  // Override parts of the generated specification
  .annotate(OpenApi.Override, {
    tags: [{ name: "a", description: "a-description" }]
  })
  // Apply a transform function to the final specification
  .annotate(OpenApi.Transform, (spec) => ({
    ...spec,
    tags: [...spec.tags, { name: "b", description: "b-description" }]
  }))

// Generate the OpenAPI specification from the annotated API
const spec = OpenApi.fromApi(api)

console.log(JSON.stringify(spec, null, 2))
/*
Output:
{
  "openapi": "3.1.0",
  "info": {
    "title": "Api",
    "version": "0.0.1",
    "description": "my description",
    "license": {
      "name": "MIT",
      "url": "http://example.com"
    },
    "summary": "my summary"
  },
  "paths": {},
  "components": {
    "schemas": {
      "MyString": {
        "type": "string"
      }
    },
    "securitySchemes": {}
  },
  "security": [],
  "tags": [
    {
      "name": "a",
      "description": "a-description"
    },
    {
      "name": "b",
      "description": "b-description"
    }
  ],
  "servers": [
    {
      "url": "http://example.com",
      "description": "example",
      "variables": {
        "a": {
          "default": "b",
          "enum": [
            "c"
          ],
          "description": "d"
        }
      }
    }
  ]
}
*/
```

#### HttpApiGroup

The following annotations can be added to an `HttpApiGroup`:

| Annotation             | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `OpenApi.Description`  | Sets a description for this group.                                    |
| `OpenApi.ExternalDocs` | Provides external documentation links for the group.                  |
| `OpenApi.Override`     | Merges specified fields into the resulting specification.             |
| `OpenApi.Transform`    | Lets you modify the final group specification with a custom function. |
| `OpenApi.Exclude`      | Excludes the group from the final OpenAPI specification.              |

**Example** (Annotating a Group)

```ts
import { HttpApi, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const api = HttpApi.make("api")
  .add(
    HttpApiGroup.make("group")
      // Add a description for the group
      .annotate(OpenApi.Description, "my description")
      // Provide external documentation links
      .annotate(OpenApi.ExternalDocs, {
        url: "http://example.com",
        description: "example"
      })
      // Override parts of the final output
      .annotate(OpenApi.Override, { name: "my name" })
      // Transform the final specification for this group
      .annotate(OpenApi.Transform, (spec) => ({
        ...spec,
        name: spec.name + "-transformed"
      }))
  )
  .add(
    HttpApiGroup.make("excluded")
      // Exclude the group from the final specification
      .annotate(OpenApi.Exclude, true)
  )

// Generate the OpenAPI spec
const spec = OpenApi.fromApi(api)

console.log(JSON.stringify(spec, null, 2))
/*
Output:
{
  "openapi": "3.1.0",
  "info": {
    "title": "Api",
    "version": "0.0.1"
  },
  "paths": {},
  "components": {
    "schemas": {},
    "securitySchemes": {}
  },
  "security": [],
  "tags": [
    {
      "name": "my name-transformed",
      "description": "my description",
      "externalDocs": {
        "url": "http://example.com",
        "description": "example"
      }
    }
  ]
}
*/
```

#### HttpApiEndpoint

For an `HttpApiEndpoint`, you can use the following annotations:

| Annotation             | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `OpenApi.Description`  | Adds a description for this endpoint.                                       |
| `OpenApi.Summary`      | Provides a short summary of the endpoint's purpose.                         |
| `OpenApi.Deprecated`   | Marks the endpoint as deprecated.                                           |
| `OpenApi.ExternalDocs` | Supplies external documentation links for the endpoint.                     |
| `OpenApi.Override`     | Merges specified fields into the resulting specification for this endpoint. |
| `OpenApi.Transform`    | Lets you modify the final endpoint specification with a custom function.    |
| `OpenApi.Exclude`      | Excludes the endpoint from the final OpenAPI specification.                 |

**Example** (Annotating an Endpoint)

```ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const api = HttpApi.make("api").add(
  HttpApiGroup.make("group")
    .add(
      HttpApiEndpoint.get("get", "/", {
        success: Schema.String
      })
        // Add a description
        .annotate(OpenApi.Description, "my description")
        // Provide a summary
        .annotate(OpenApi.Summary, "my summary")
        // Mark the endpoint as deprecated
        .annotate(OpenApi.Deprecated, true)
        // Provide external documentation
        .annotate(OpenApi.ExternalDocs, {
          url: "http://example.com",
          description: "example"
        })
    )
    .add(
      HttpApiEndpoint.get("excluded", "/excluded", {
        success: Schema.String
      })
        // Exclude this endpoint from the final specification
        .annotate(OpenApi.Exclude, true)
    )
)

// Generate the OpenAPI spec
const spec = OpenApi.fromApi(api)

console.log(JSON.stringify(spec, null, 2))
/*
Output:
{
  "openapi": "3.1.0",
  "info": {
    "title": "Api",
    "version": "0.0.1"
  },
  "paths": {
    "/": {
      "get": {
        "tags": [
          "group"
        ],
        "operationId": "group.get",
        "parameters": [],
        "security": [],
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/String_"
                }
              }
            }
          },
          "400": {
            "description": "The request or response did not match the expected schema",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "_tag": {
                      "type": "string",
                      "enum": [
                        "HttpApiSchemaError"
                      ]
                    },
                    "message": {
                      "$ref": "#/components/schemas/String_"
                    }
                  },
                  "required": [
                    "_tag",
                    "message"
                  ],
                  "additionalProperties": false
                }
              }
            }
          }
        },
        "description": "my description",
        "summary": "my summary",
        "deprecated": true,
        "externalDocs": {
          "url": "http://example.com",
          "description": "example"
        }
      }
    }
  },
  "components": {
    "schemas": {
      "String_": {
        "type": "string"
      }
    },
    "securitySchemes": {}
  },
  "security": [],
  "tags": [
    {
      "name": "group"
    }
  ]
}
*/
```

The default response description is "Success". You can override this by annotating the schema.

**Example** (Defining a custom response description)

```ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const User = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String
}).annotate({ identifier: "User" })

const api = HttpApi.make("api").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("getUsers", "/users", {
      success: Schema.Array(User).annotate({
        description: "Returns an array of users"
      })
    })
  )
)

const spec = OpenApi.fromApi(api)

console.log(JSON.stringify(spec.paths, null, 2))
/*
Output:
{
  "/users": {
    "get": {
      "tags": [
        "group"
      ],
      "operationId": "group.getUsers",
      "parameters": [],
      "security": [],
      "responses": {
        "200": {
          "description": "Returns an array of users",
          "content": {
            "application/json": {
              "schema": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "number"
                    },
                    "name": {
                      "$ref": "#/components/schemas/String_"
                    }
                  },
                  "required": [
                    "id",
                    "name"
                  ],
                  "additionalProperties": false
                },
                "description": "Returns an array of users"
              }
            }
          }
        },
        "400": {
          "description": "The request or response did not match the expected schema",
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "HttpApiSchemaError"
                    ]
                  },
                  "message": {
                    "$ref": "#/components/schemas/String_"
                  }
                },
                "required": [
                  "_tag",
                  "message"
                ],
                "additionalProperties": false
              }
            }
          }
        }
      }
    }
  }
}
*/
```

## Top Level Groups

When a group is `topLevel`, its name is not prepended to operation IDs in the OpenAPI spec. Use this when the group is just for tagging and you want shorter, cleaner operation IDs.

**Example** (Using a Top-Level Group)

```ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const api = HttpApi.make("api").add(
  // Mark the group as top-level
  HttpApiGroup.make("group", { topLevel: true }).add(
    HttpApiEndpoint.get("get", "/", {
      success: Schema.String
    })
  )
)

// Generate the OpenAPI spec
const spec = OpenApi.fromApi(api)

console.log(JSON.stringify(spec.paths, null, 2))
/*
Output:
{
  "/": {
    "get": { // The operation ID is not prefixed with "group"
      "tags": [
        "group"
      ],
      "operationId": "get",
      "parameters": [],
      "security": [],
      "responses": {
        "200": {
          "description": "Success",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/String_"
              }
            }
          }
        },
        "400": {
          "description": "The request or response did not match the expected schema",
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "HttpApiSchemaError"
                    ]
                  },
                  "message": {
                    "$ref": "#/components/schemas/String_"
                  }
                },
                "required": [
                  "_tag",
                  "message"
                ],
                "additionalProperties": false
              }
            }
          }
        }
      }
    }
  }
}
*/
```

# Deriving a Client

The `HttpApiClient` module generates a fully typed client from your API definition. Each endpoint becomes a method — grouped by `HttpApiGroup` name — so calling your API is as simple as calling a function.

**Example** (Deriving and Using a Client)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Greetings")
      .add(
        HttpApiEndpoint.get("hello", "/", {
          success: Schema.String
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Greetings",
  (handlers) => handlers.handle("hello", () => Effect.succeed("Hello, World!"))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

// Create a program that derives and uses the client
const program = Effect.gen(function*() {
  // Derive the client
  const client = yield* HttpApiClient.make(Api, {
    baseUrl: "http://localhost:3000"
  })
  // Call the "hello-world" endpoint
  const hello = yield* client.Greetings.hello()
  console.log(hello)
})

// Provide a Fetch-based HTTP client and run the program
Effect.runFork(program.pipe(Effect.provide(FetchHttpClient.layer)))
/*
Output:
[18:55:26.051] INFO (#2): Listening on http://0.0.0.0:3000
[18:55:26.057] INFO (#12) http.span=2ms: Sent HTTP response { 'http.method': 'GET', 'http.url': '/', 'http.status': 200 }
Hello, World!
*/
```

## Top Level Groups

When a group is `topLevel`, its endpoints are exposed as top-level methods on the client instead of being nested under the group name.

**Example** (Using a Top-Level Group in the Client)

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const Api = HttpApi.make("MyApi")
  .add(
    HttpApiGroup.make("Greetings", { topLevel: true })
      .add(
        HttpApiEndpoint.get("hello", "/", {
          success: Schema.String
        })
      )
  )

const GroupLive = HttpApiBuilder.group(
  Api,
  "Greetings",
  (handlers) => handlers.handle("hello", () => Effect.succeed("Hello, World!"))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ApiLive).pipe(NodeRuntime.runMain)

const program = Effect.gen(function*() {
  const client = yield* HttpApiClient.make(Api, {
    baseUrl: "http://localhost:3000"
  })
  // The `hello` method is not nested under the "group" name
  const hello = yield* client.hello()
  console.log(hello)
})

Effect.runFork(program.pipe(Effect.provide(FetchHttpClient.layer)))
```

# Converting to a Web Handler

If you need to plug your API into an existing HTTP server (instead of using `NodeHttpServer`), convert it to a standard web handler with `HttpApiBuilder.toWebHandler`. The returned `handler` function takes a `Request` and returns a `Response`.

**Example** (Creating and Serving a Web Handler)

```ts
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiScalar } from "effect/unstable/httpapi"
import * as http from "node:http"

const Api = HttpApi.make("myApi").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("get", "/", {
      success: Schema.String
    })
  )
)

const GroupLive = HttpApiBuilder.group(
  Api,
  "group",
  (handlers) => handlers.handle("get", () => Effect.succeed("Hello, world!"))
)

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(GroupLive),
  Layer.provide(HttpApiScalar.layer(Api)),
  Layer.provide(HttpServer.layerServices)
)

// Convert the API to a web handler
const { dispose, handler } = HttpRouter.toWebHandler(
  Layer.mergeAll(ApiLive)
)

// Serving the handler using a custom HTTP server
http
  .createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`
    const init: RequestInit = {
      method: req.method!
    }

    const response = await handler(new Request(url, init))

    res.writeHead(
      response.status,
      response.statusText,
      Object.fromEntries(response.headers.entries())
    )
    const responseBody = await response.arrayBuffer()
    res.end(Buffer.from(responseBody))
  })
  .listen(3000, () => {
    console.log("Server running at http://localhost:3000/")
  })
  .on("close", () => {
    dispose()
  })
```
