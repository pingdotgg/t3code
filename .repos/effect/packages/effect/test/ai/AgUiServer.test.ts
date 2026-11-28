import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import {
  type AgUiSchema,
  AgUiServer,
  LanguageModel,
  type Prompt,
  type Response as AiResponse,
  Tool,
  Toolkit
} from "effect/ai"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiGroup, OpenApi } from "effect/http-api"

const TestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

const withHandler = <A, E, R>(
  run: (input: AgUiSchema.RunAgentInput) => Stream.Stream<AgUiSchema.Event, unknown>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        AgUiServer.layerHttp({ path: "/agent", run }).pipe(Layer.provide(TestServices)),
        { disableLogger: true }
      )
    ),
    ({ handler }) => use(handler),
    ({ dispose }) => Effect.promise(dispose)
  )

const withLayer = <A, E, R>(
  layer: Layer.Layer<never, never, HttpRouter.HttpRouter>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
    ({ handler }) => use(handler),
    ({ dispose }) => Effect.promise(dispose)
  )

const post = (handler: (request: Request) => Promise<Response>, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request("http://test/agent", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body)
      })
    )
  )

// Every frame must be a single `data:` line, because AG-UI clients such as
// TanStack AI read only `data:` lines.
const readEvents = (response: Response) =>
  Effect.promise(() => response.text()).pipe(
    Effect.map((text) => {
      assert.isTrue(text.endsWith("\n\n"))
      return text.slice(0, -2).split("\n\n").map((frame) => {
        assert.isTrue(frame.startsWith("data: "), frame)
        assert.notInclude(frame, "\n", frame)
        return JSON.parse(frame.slice("data: ".length))
      })
    })
  )

const input = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [{ id: "1", role: "user", content: "Hi" }]
}

// A server tool that reads the run it serves
const Lookup = Tool.make("Lookup", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  dependencies: [AgUiServer.RunInput]
})

const AgentToolkit = Toolkit.make(Lookup)

const AgentToolkitLayer = AgentToolkit.toLayer({
  Lookup: Effect.fnUntraced(function*() {
    const input = yield* AgUiServer.RunInput
    return input.threadId
  })
})

const finish = (reason: AiResponse.FinishReason): AiResponse.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } }
})

// A model that answers each request with the next round and records the
// prompt and tool names it was given
const fakeModel = (rounds: ReadonlyArray<ReadonlyArray<AiResponse.StreamPartEncoded>>) => {
  const requests: Array<{ readonly prompt: Prompt.Prompt; readonly tools: ReadonlyArray<string> }> = []
  const model = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) => {
        requests.push({ prompt: options.prompt, tools: options.tools.map((tool) => tool.name).sort() })
        return Stream.fromIterable(rounds[requests.length - 1] ?? [finish("stop")])
      }
    })
  )
  return { requests, model }
}

const serveAgent = (
  rounds: ReadonlyArray<ReadonlyArray<AiResponse.StreamPartEncoded>>,
  agent: AgUiServer.Agent<
    LanguageModel.LanguageModel | Tool.HandlersFor<Toolkit.Tools<typeof AgentToolkit>>
  > = AgUiServer.agent({ toolkit: AgentToolkit, system: "Be brief", maxSteps: 5 })
) => {
  const { model, requests } = fakeModel(rounds)
  const layer = AgUiServer.layerHttp({ path: "/agent", agent }).pipe(
    Layer.provide([TestServices, model, AgentToolkitLayer])
  )
  return { requests, layer }
}

// A client-executed tool configured on the server rather than sent by the
// application
const Confirm = Tool.make("Confirm", {
  parameters: Schema.Struct({ question: Schema.String }),
  success: Schema.Boolean,
  execution: "client"
})

// Generated message ids differ per run
const stableIds = (events: ReadonlyArray<any>) =>
  events.map((event) => event.type === "TOOL_CALL_RESULT" ? { ...event, messageId: "<id>" } : event)

describe("AgUiServer", () => {
  it.effect("streams a run hook's events as AG-UI server-sent events", () =>
    withHandler(
      (input) =>
        Stream.fromIterable<AgUiSchema.Event>([
          { type: "TEXT_MESSAGE_START", messageId: input.runId, role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: input.runId, delta: `tools: ${input.tools.length}` }
        ]),
      (handler) =>
        Effect.gen(function*() {
          const response = yield* post(handler, input)

          assert.strictEqual(response.status, 200)
          assert.isTrue(response.headers.get("content-type")?.startsWith("text/event-stream"))
          assert.strictEqual(response.headers.get("cache-control"), "no-cache")
          assert.deepStrictEqual(yield* readEvents(response), [
            { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1", protocolVersion: "1.0" },
            { type: "TEXT_MESSAGE_START", messageId: "run-1", role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId: "run-1", delta: "tools: 0" },
            { type: "TEXT_MESSAGE_END", messageId: "run-1" },
            { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" }
          ])
        })
    ))

  it.effect("serves the run overload when an undefined agent property is present", () => {
    // A variable passed to the run overload may carry extra properties, so an
    // undefined agent must not be selected over the run function
    const options = {
      path: "/agent" as const,
      agent: undefined,
      run: (): Stream.Stream<AgUiSchema.Event> => Stream.empty
    }
    return withLayer(
      AgUiServer.layerHttp(options).pipe(Layer.provide(TestServices)),
      (handler) =>
        Effect.gen(function*() {
          const response = yield* post(handler, input)

          assert.strictEqual(response.status, 200)
          assert.deepStrictEqual(yield* readEvents(response), [
            { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1", protocolVersion: "1.0" },
            { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" }
          ])
        })
    )
  })

  it.effect("rejects an invalid RunAgentInput before opening the stream", () =>
    withHandler(
      () => Stream.empty,
      (handler) =>
        Effect.gen(function*() {
          const response = yield* post(handler, { threadId: "thread-1" })

          assert.strictEqual(response.status, 400)
          assert.isFalse(response.headers.get("content-type")?.startsWith("text/event-stream") ?? false)
        })
    ))

  it.effect("reports a failing run hook as RUN_ERROR", () =>
    withHandler(
      () => Stream.fail(new Error("boom")),
      (handler) =>
        Effect.gen(function*() {
          const response = yield* post(handler, input)
          const events = yield* readEvents(response)

          assert.strictEqual(response.status, 200)
          assert.deepStrictEqual(events[0], {
            type: "RUN_STARTED",
            threadId: "thread-1",
            runId: "run-1",
            protocolVersion: "1.0"
          })
          assert.strictEqual(events.length, 2)
          assert.strictEqual(events[1].type, "RUN_ERROR")
        })
    ))

  it.effect("reports an event that cannot be encoded as RUN_ERROR", () =>
    withHandler(
      () => Stream.fromIterable<AgUiSchema.Event>([{ type: "CUSTOM", name: "progress", value: 1n }]),
      (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, input).pipe(Effect.flatMap(readEvents))

          assert.strictEqual(events.length, 2)
          assert.strictEqual(events[0].type, "RUN_STARTED")
          assert.strictEqual(events[1].type, "RUN_ERROR")
        })
    ))

  it.effect("reports an event that is invalid once serialized as RUN_ERROR", () =>
    // JSON drops the required `value` of a CUSTOM event when it is undefined
    withHandler(
      () => Stream.fromIterable<AgUiSchema.Event>([{ type: "CUSTOM", name: "progress", value: undefined }]),
      (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, input).pipe(Effect.flatMap(readEvents))

          assert.strictEqual(events.length, 2)
          assert.strictEqual(events[0].type, "RUN_STARTED")
          assert.strictEqual(events[1].type, "RUN_ERROR")
        })
    ))

  it.effect("never serializes an event outside the run's error handling", () => {
    // A value whose JSON form can only be computed once: delivering it is fine
    // if it is serialized once, and failing the run is fine, but a second
    // serialization must not leak an HttpApi failure frame
    let serialized = 0
    const value = {
      toJSON: () => {
        if (++serialized > 1) throw new Error("serialized twice")
        return { done: 1 }
      }
    }
    return withHandler(
      () => Stream.fromIterable<AgUiSchema.Event>([{ type: "CUSTOM", name: "progress", value }]),
      (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, input).pipe(Effect.flatMap(readEvents))
          const last = events[events.length - 1]

          assert.strictEqual(events[0].type, "RUN_STARTED")
          assert.include(["RUN_FINISHED", "RUN_ERROR"], last.type)
          for (const event of events.filter((event) => event.type === "CUSTOM")) {
            assert.deepStrictEqual(event, { type: "CUSTOM", name: "progress", value: { done: 1 } })
          }
        })
    )
  })

  describe("agent", () => {
    it.effect("runs the model with server tools until it answers", () => {
      const { requests, layer } = serveAgent([
        [{ type: "tool-call", id: "call-1", name: "Lookup", params: { key: "a" } }, finish("tool-calls")],
        [
          { type: "text-start", id: "m1" },
          { type: "text-delta", id: "m1", delta: "Done" },
          { type: "text-end", id: "m1" },
          finish("stop")
        ]
      ])
      return withLayer(layer, (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, input).pipe(Effect.flatMap(readEvents))

          // The server's system prompt comes first, ahead of the client's
          // conversation
          assert.strictEqual(requests.length, 2)
          assert.deepStrictEqual(requests[0].prompt.content.map((message) => message.role), ["system", "user"])
          assert.deepStrictEqual(requests[0].prompt.content[0].content, "Be brief")
          assert.deepStrictEqual(stableIds(events), [
            { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1", protocolVersion: "1.0" },
            { type: "STEP_STARTED", stepName: "step-1" },
            { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "Lookup" },
            { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: `{"key":"a"}` },
            { type: "TOOL_CALL_END", toolCallId: "call-1" },
            { type: "TOOL_CALL_RESULT", messageId: "<id>", toolCallId: "call-1", content: "thread-1" },
            { type: "STEP_FINISHED", stepName: "step-1" },
            { type: "STEP_STARTED", stepName: "step-2" },
            { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Done" },
            { type: "TEXT_MESSAGE_END", messageId: "m1" },
            { type: "STEP_FINISHED", stepName: "step-2" },
            {
              type: "RUN_FINISHED",
              threadId: "thread-1",
              runId: "run-1",
              usage: [{ inputTokens: 6, outputTokens: 4, totalTokens: 10 }]
            }
          ])
        }))
    })

    it.effect("finishes with the frontend tool calls left for the application", () => {
      const { requests, layer } = serveAgent([[
        { type: "tool-call", id: "call-1", name: "confirm", params: { question: "Proceed?" } },
        finish("tool-calls")
      ]])
      return withLayer(layer, (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, {
            ...input,
            tools: [{
              name: "confirm",
              description: "Asks the user to confirm",
              parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] }
            }]
          }).pipe(Effect.flatMap(readEvents))

          assert.strictEqual(requests.length, 1)
          assert.deepStrictEqual(requests[0].tools, ["Lookup", "confirm"])
          assert.isFalse(events.some((event) => event.type === "TOOL_CALL_RESULT"))
          assert.deepStrictEqual(events[events.length - 1], {
            type: "RUN_FINISHED",
            threadId: "thread-1",
            runId: "run-1",
            outcome: { type: "success", pendingToolCallIds: ["call-1"] },
            usage: [{ inputTokens: 3, outputTokens: 2, totalTokens: 5 }]
          })
        }))
    })

    it.effect("lists calls to client-executed toolkit tools as pending", () => {
      const { layer } = serveAgent(
        [[
          { type: "tool-call", id: "call-1", name: "Confirm", params: { question: "Proceed?" } },
          finish("tool-calls")
        ]],
        AgUiServer.agent({ toolkit: Toolkit.make(Lookup, Confirm), maxSteps: 5 })
      )
      return withLayer(layer, (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, input).pipe(Effect.flatMap(readEvents))

          assert.deepStrictEqual(events[events.length - 1].outcome, { type: "success", pendingToolCallIds: ["call-1"] })
        }))
    })

    it.effect("serves an agent from an endpoint in an existing HttpApi", () => {
      const { model, requests } = fakeModel([[
        { type: "text-start", id: "m1" },
        { type: "text-delta", id: "m1", delta: "Hi there" },
        { type: "text-end", id: "m1" },
        finish("stop")
      ]])
      const api = HttpApi.make("App").add(HttpApiGroup.make("ai").add(AgUiServer.endpoint("run", "/agent")))
      const AiLive = HttpApiBuilder.group(api, "ai", (handlers) =>
        Effect.map(
          AgUiServer.agentHandler(AgUiServer.agent({ toolkit: AgentToolkit, maxSteps: 5 })),
          (run) => handlers.handle("run", run)
        ))
      const layer = HttpApiBuilder.layer(api).pipe(
        Layer.provide(AiLive),
        Layer.provide([TestServices, model, AgentToolkitLayer])
      )
      return withLayer(layer, (handler) =>
        Effect.gen(function*() {
          const events = yield* post(handler, input).pipe(Effect.flatMap(readEvents))
          assert.strictEqual(events[0].type, "RUN_STARTED")
          assert.deepStrictEqual(events[events.length - 1], {
            type: "RUN_FINISHED",
            threadId: "thread-1",
            runId: "run-1",
            usage: [{ inputTokens: 3, outputTokens: 2, totalTokens: 5 }]
          })

          // Validation still answers before the stream opens
          const rejected = yield* post(handler, { ...input, tools: [{ name: "Lookup", description: "Shadows" }] })
          assert.strictEqual(rejected.status, 400)
          assert.strictEqual(requests.length, 1)
        }))
    })

    it.effect("rejects a frontend tool that shadows a server tool before the stream opens", () => {
      const { requests, layer } = serveAgent([])
      return withLayer(layer, (handler) =>
        Effect.gen(function*() {
          const response = yield* post(handler, {
            ...input,
            tools: [{ name: "Lookup", description: "Shadows the server tool" }]
          })

          assert.strictEqual(response.status, 400)
          assert.strictEqual(requests.length, 0)
        }))
    })
  })

  it("documents the item schemas of the run input in OpenAPI", () => {
    const api = HttpApi.make("Api").add(HttpApiGroup.make("agent").add(AgUiServer.endpoint("run", "/agent")))
    const spec = JSON.parse(JSON.stringify(OpenApi.fromApi(api)))
    const payload = spec.paths["/agent"].post.requestBody.content["application/json"].schema

    // Every array in the payload, including messages and nested content
    // parts, must describe its items, and no union may have a branch that
    // accepts anything or be empty: generated clients would reduce the union
    // to `unknown`, and an empty `anyOf`/`oneOf` is invalid JSON Schema
    const annotationKeys = new Set(["title", "description", "examples", "default", "$comment", "deprecated"])
    const isUnconstrained = (schema: unknown) =>
      typeof schema !== "object" || schema === null ||
      Object.keys(schema).every((key) => annotationKeys.has(key))
    const findProblems = (root: unknown): Array<string> => {
      const problems: Array<string> = []
      const visit = (schema: unknown, path: string): void => {
        if (typeof schema !== "object" || schema === null) return
        const node = schema as Record<string, unknown>
        if (node.type === "array" && isUnconstrained(node.items)) {
          problems.push(`${path}/items is missing`)
        }
        for (const key of ["anyOf", "oneOf"]) {
          const branches = node[key]
          if (!Array.isArray(branches)) continue
          if (branches.length === 0) problems.push(`${path}/${key} is empty`)
          branches.forEach((branch, index) => {
            if (isUnconstrained(branch)) problems.push(`${path}/${key}/${index} is unconstrained`)
          })
        }
        for (const [key, child] of Object.entries(node)) visit(child, `${path}/${key}`)
      }
      visit(root, "")
      return problems
    }

    assert.isDefined(payload.properties.messages.items)
    assert.deepStrictEqual(findProblems(payload), [])

    // The check must catch the fallback branch surviving union flattening,
    // at the top of a union and nested inside one
    const injected = (inject: (payload: any) => void) => {
      const copy = structuredClone(payload)
      inject(copy)
      return findProblems(copy)
    }
    const userContentParts = (payload: any) =>
      payload.properties.messages.items.anyOf
        .find((message: any) => message.properties.role.enum?.includes("user"))
        .properties.content.anyOf.find((content: any) => content.type === "array").items
    assert.isNotEmpty(injected((payload) => payload.properties.messages.items.anyOf.push({ anyOf: [] })))
    assert.isNotEmpty(injected((payload) => userContentParts(payload).anyOf.push({ oneOf: [] })))
    assert.isNotEmpty(injected((payload) => {
      payload.properties.resume.items = { anyOf: [] }
    }))
  })
})
