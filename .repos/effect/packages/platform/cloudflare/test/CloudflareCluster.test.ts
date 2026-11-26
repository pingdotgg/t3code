import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import {
  CurrentEntityName,
  CurrentReplyRegistry,
  makeReplyRegistry
} from "@effect/platform-cloudflare/internal/entityReply"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, DateTime, Effect, Exit, Fiber, Layer, PrimaryKey, Schema, Stream } from "effect"
import { ClusterSchema, DeliverAt, Entity, EntityProxy, EntityProxyServer, Sharding } from "effect/cluster"
import { PersistenceError } from "effect/cluster/ClusterError"
import { Headers } from "effect/http"
import { Rpc, RpcMiddleware, RpcSchema, RpcTest } from "effect/rpc"
import { TestClock } from "effect/testing"
import * as v8 from "node:v8"
import * as vm from "node:vm"

const User = Entity.make("User", [
  Rpc.make("Ping", { success: Schema.String })
])

const PersistedUser = Entity.make("PersistedUser", [
  Rpc.make("Ping", { success: Schema.String }).annotate(ClusterSchema.Persisted, true)
])

const ClientUninterruptible = Entity.make("ClientUninterruptible", [
  Rpc.make("Ping", { success: Schema.String }).annotate(ClusterSchema.Uninterruptible, "client")
])

const Counter = Entity.make("Counter", [
  Rpc.make("Increment")
])

const Numbers = Entity.make("Numbers", [
  Rpc.make("Count", { success: RpcSchema.Stream(Schema.Number, Schema.Never) })
])

class Stamp extends RpcMiddleware.Service<Stamp>()("CloudflareClusterTest/Stamp") {}

const Stamped = Entity.make("Stamped", [
  Rpc.make("Ping", { success: Schema.String }).middleware(Stamp)
])

class ScheduledPayload extends Schema.Class<ScheduledPayload>("CloudflareScheduledPayload")({
  deliverAt: Schema.Number,
  id: Schema.String
}) {
  [PrimaryKey.symbol]() {
    return this.id
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.deliverAt)
  }
}

class UnkeyedScheduledPayload extends Schema.Class<UnkeyedScheduledPayload>("CloudflareUnkeyedScheduledPayload")({
  deliverAt: Schema.Number
}) {
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.deliverAt)
  }
}

const Scheduled = Entity.make("Scheduled", [
  Rpc.make("Ask", { payload: ScheduledPayload, success: Schema.String }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Tell", { payload: ScheduledPayload }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Unkeyed", { payload: UnkeyedScheduledPayload, success: Schema.String }).annotate(
    ClusterSchema.Persisted,
    true
  ),
  Rpc.make("Stream", {
    payload: ScheduledPayload,
    success: RpcSchema.Stream(Schema.Number, Schema.Never)
  }).annotate(ClusterSchema.Persisted, true)
])

class FakeNamespace {
  readonly names: Array<string> = []
  constructor(readonly stub: object = {}) {}

  getByName(name: string) {
    this.names.push(name)
    return this.stub
  }
}

// Resolves a new stub for every `getByName`, as a real namespace does.
class FreshNamespace {
  readonly stubs: Array<object> = []
  constructor(readonly makeStub: () => object) {}

  getByName() {
    const stub = this.makeStub()
    this.stubs.push(stub)
    return stub
  }
}

const transportError = () => Object.assign(new Error("Network connection lost."), { retryable: true })

// Advances the TestClock until the effect completes, so retry backoff runs
// without real waiting.
const withTestClock = Effect.fnUntraced(function*<A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkChild(effect)
  for (let index = 0; index < 1000 && fiber.pollUnsafe() === undefined; index++) {
    yield* TestClock.adjust("1 minute")
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  return yield* Fiber.join(fiber)
})

// Forces a full collection where the runtime allows it: `Bun.gc` on Bun, and
// V8's `gc` exposed at runtime on Node and Deno. Without one, the test that
// needs it is skipped.
const forceGc = ((): (() => void) | undefined => {
  const bun = (globalThis as { readonly Bun?: { readonly gc: (force: boolean) => void } }).Bun
  if (bun !== undefined) return () => bun.gc(true)
  try {
    v8.setFlagsFromString("--expose-gc")
    return vm.runInNewContext("gc") as () => void
  } catch {
    return undefined
  }
})()

class Marker extends Context.Service<Marker, object>()("CloudflareClusterTest/Marker") {}

const makeOptions = (stub?: object) => {
  const entityNamespace = new FakeNamespace(stub)
  const options: CloudflareCluster.LayerOptions = {
    entities: [User, Numbers, Stamped],
    entityNamespace: entityNamespace as any,
    workflowNamespace: new FakeNamespace() as any,
    queueNamespace: new FakeNamespace() as any,
    singletonNamespace: new FakeNamespace() as any
  }
  return { entityNamespace, options }
}

// Replies to every request with the encoded replies built from its request id.
const replyingStub = (replies: (requestId: string) => ReadonlyArray<object>) => ({
  invoke(envelopeText: string) {
    const requestId = JSON.parse(envelopeText).requestId
    return Promise.resolve({
      _tag: "Success",
      requestId,
      replies: replies(requestId).map((reply) => JSON.stringify(reply))
    })
  },
  acknowledge() {
    return Promise.resolve([])
  }
})

const pongStub = () =>
  replyingStub((requestId) => [{ _tag: "WithExit", requestId, id: "pong", exit: { _tag: "Success", value: "pong" } }])

describe("CloudflareCluster", () => {
  describe("Entity.client", () => {
    it("works without a caller Scope", async () => {
      const { options } = makeOptions(pongStub())
      const result = await Effect.runPromise(
        Effect.flatMap(User.client, (makeClient) => makeClient("42").Ping(void 0)).pipe(
          Effect.provide(CloudflareCluster.layer(options))
        )
      )
      assert.strictEqual(result, "pong")
    })

    it.effect("keeps working after the scope it was obtained in closes", () =>
      Effect.gen(function*() {
        const makeClient = yield* Effect.scoped(User.client)
        const result = yield* makeClient("42").Ping(void 0)
        assert.strictEqual(result, "pong")
      }).pipe(Effect.provide(CloudflareCluster.layer(makeOptions(pongStub()).options))))

    it.effect("returns a Dequeue for a streaming RPC with asQueue: true", () =>
      Effect.gen(function*() {
        const makeClient = yield* Numbers.client
        const queue = yield* makeClient("42").Count(void 0, { asQueue: true })
        const values = yield* Stream.runCollect(Stream.fromQueue(queue))
        assert.deepStrictEqual(values, [1, 2])
      }).pipe(Effect.provide(CloudflareCluster.layer(
        makeOptions(replyingStub((requestId) => [
          { _tag: "Chunk", requestId, id: "chunk", sequence: 0, values: [1, 2] },
          { _tag: "WithExit", requestId, id: "exit", exit: { _tag: "Success", value: null } }
        ])).options
      ))))

    it.effect("runs client middleware provided to the layer", () => {
      const envelopes: Array<any> = []
      const stub = pongStub()
      const invoke = stub.invoke
      stub.invoke = (envelopeText) => {
        envelopes.push(JSON.parse(envelopeText))
        return invoke(envelopeText)
      }
      const StampClient = RpcMiddleware.layerClient(
        Stamp,
        ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "x-stamp", "layer") })
      )
      return Effect.gen(function*() {
        const makeClient = yield* Stamped.client
        assert.strictEqual(yield* makeClient("42").Ping(void 0), "pong")
        assert.strictEqual(envelopes[0].headers["x-stamp"], "layer")
      }).pipe(Effect.provide(CloudflareCluster.layer(makeOptions(stub).options).pipe(Layer.provide(StampClient))))
    })
  })

  describe("layer", () => {
    it.effect("routes generated entity proxy handlers through the encoded Durable Object name", () => {
      const stub = {
        invoke(envelopeText: string) {
          const envelope = JSON.parse(envelopeText)
          return Promise.resolve({
            _tag: "Success",
            requestId: envelope.requestId,
            replies: [JSON.stringify({
              _tag: "WithExit",
              requestId: envelope.requestId,
              id: "proxy-reply",
              exit: { _tag: "Success", value: "pong" }
            })]
          })
        },
        acknowledge() {
          return Promise.resolve([])
        }
      }
      const entityNamespace = new FakeNamespace(stub)
      const options: CloudflareCluster.LayerOptions = {
        entities: [User],
        entityNamespace: entityNamespace as any,
        workflowNamespace: new FakeNamespace() as any,
        queueNamespace: new FakeNamespace() as any,
        singletonNamespace: new FakeNamespace() as any
      }
      const proxy = EntityProxy.toRpcGroup(User)

      return Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(proxy)
        const result = yield* client["User.Ping"]({ entityId: "proxy:id", payload: undefined })

        assert.strictEqual(result, "pong")
        assert.deepStrictEqual(entityNamespace.names, ["4:Userproxy:id"])
      }).pipe(
        Effect.provide(EntityProxyServer.layerRpcHandlers(User)),
        Effect.provide(CloudflareCluster.layer(options))
      )
    })

    it.effect("uses uuidv7 request ids and decodes replies from the entity Durable Object", () => {
      const envelopes: Array<any> = []
      const stub = {
        invoke(envelopeText: string) {
          const envelope = JSON.parse(envelopeText)
          envelopes.push(envelope)
          return Promise.resolve({
            _tag: "Success",
            requestId: envelope.requestId,
            replies: [JSON.stringify({
              _tag: "WithExit",
              requestId: envelope.requestId,
              id: "reply-1",
              exit: { _tag: "Success", value: "pong" }
            })]
          })
        },
        acknowledge() {
          return Promise.resolve([])
        }
      }
      const entityNamespace = new FakeNamespace(stub)
      const options: CloudflareCluster.LayerOptions = {
        entities: [User],
        entityNamespace: entityNamespace as any,
        workflowNamespace: new FakeNamespace() as any,
        queueNamespace: new FakeNamespace() as any,
        singletonNamespace: new FakeNamespace() as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* User.client
        const result = yield* makeClient("42").Ping(void 0)
        assert.strictEqual(result, "pong")
        assert.match(envelopes[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        assert.strictEqual(envelopes[0].address.entityType, "User")
        assert.strictEqual(envelopes[0].address.entityId, "42")
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect("delivers a deduplicated delayed reply pushed before the invoke result to every pinned caller", () => {
      const registry = makeReplyRegistry()
      const pending: Array<(value: any) => void> = []
      const clientRequestIds: Array<string> = []
      let bothInvoked!: () => void
      const invoked = new Promise<void>((resolve) => {
        bothInvoked = resolve
      })
      const stub = {
        invoke(envelopeText: string, _discard: boolean, delivery: { readonly replyTo?: string }) {
          assert.strictEqual(delivery.replyTo, "6:Callerone")
          clientRequestIds.push(JSON.parse(envelopeText).requestId)
          return new Promise<any>((resolve) => {
            pending.push(resolve)
            if (pending.length === 2) bothInvoked()
          })
        },
        acknowledge() {
          return Promise.resolve([])
        }
      }
      const options: CloudflareCluster.LayerOptions = {
        entities: [Scheduled],
        entityNamespace: new FakeNamespace(stub) as any,
        workflowNamespace: new FakeNamespace() as any,
        queueNamespace: new FakeNamespace() as any,
        singletonNamespace: new FakeNamespace() as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* Scheduled.client
        const client = makeClient("one")
        const request = { deliverAt: Date.now() + 60_000, id: "shared" }
        const pinned = (effect: Effect.Effect<string, any>) =>
          effect.pipe(
            Effect.provideService(CurrentEntityName, "6:Callerone"),
            Effect.provideService(CurrentReplyRegistry, registry)
          )
        const first = yield* Effect.forkChild(pinned(client.Ask(request)))
        const second = yield* Effect.forkChild(pinned(client.Ask(request)))
        yield* Effect.promise(() => invoked)
        const storageRequestId = clientRequestIds[0]
        // The destination pushes under each caller's own request id, possibly
        // before the caller has seen its invoke result.
        for (const requestId of clientRequestIds) {
          const delivered = registry.deliver(
            requestId,
            JSON.stringify({
              _tag: "WithExit",
              requestId: storageRequestId,
              id: "terminal",
              exit: { _tag: "Success", value: "callback" }
            })
          )
          assert.isTrue(delivered)
        }
        for (const resolve of pending) resolve({ _tag: "Success", requestId: storageRequestId, replies: [] })

        assert.deepStrictEqual(yield* Fiber.join(first), "callback")
        assert.deepStrictEqual(yield* Fiber.join(second), "callback")
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect("rejects unkeyed and streaming asks with a future DeliverAt", () => {
      let invoked = 0
      const stub = {
        invoke() {
          invoked++
          return Promise.resolve({ _tag: "Success", requestId: "unused", replies: [] })
        },
        acknowledge() {
          return Promise.resolve([])
        }
      }
      const options: CloudflareCluster.LayerOptions = {
        entities: [Scheduled],
        entityNamespace: new FakeNamespace(stub) as any,
        workflowNamespace: new FakeNamespace() as any,
        queueNamespace: new FakeNamespace() as any,
        singletonNamespace: new FakeNamespace() as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* Scheduled.client
        const client = makeClient("one")
        const deliverAt = Date.now() + 60_000
        assert.isTrue(Exit.isFailure(yield* client.Unkeyed({ deliverAt }).pipe(Effect.exit)))
        assert.isTrue(
          Exit.isFailure(yield* client.Stream({ deliverAt, id: "stream" }).pipe(Stream.runDrain, Effect.exit))
        )
        assert.strictEqual(invoked, 0)
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect("surfaces ask-to-tell deduplication as a persistence failure", () => {
      const registry = makeReplyRegistry()
      const stub = {
        invoke() {
          return Promise.resolve({ _tag: "AskDeduplicatedToTell" as const })
        },
        acknowledge() {
          return Promise.resolve([])
        }
      }
      const options: CloudflareCluster.LayerOptions = {
        entities: [Scheduled],
        entityNamespace: new FakeNamespace(stub) as any,
        workflowNamespace: new FakeNamespace() as any,
        queueNamespace: new FakeNamespace() as any,
        singletonNamespace: new FakeNamespace() as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* Scheduled.client
        const exit = yield* makeClient("one").Ask({ deliverAt: Date.now() + 60_000, id: "tell" }).pipe(
          Effect.provideService(CurrentEntityName, "6:Callerone"),
          Effect.provideService(CurrentReplyRegistry, registry),
          Effect.exit
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.isFalse(registry.deliver("original-tell", "unused"))
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect("bounds retained reset targets for persisted requests", () => {
      const requestIds: Array<string> = []
      const resets: Array<string> = []
      const stub = {
        invoke(envelopeText: string) {
          const requestId = JSON.parse(envelopeText).requestId
          requestIds.push(requestId)
          return Promise.resolve({
            _tag: "Success",
            requestId,
            replies: [JSON.stringify({
              _tag: "WithExit",
              requestId,
              id: `terminal-${requestIds.length}`,
              exit: { _tag: "Success", value: "pong" }
            })]
          })
        },
        acknowledge() {
          return Promise.resolve([])
        },
        reset(requestId: string) {
          resets.push(requestId)
          return Promise.resolve()
        }
      }
      const options: CloudflareCluster.LayerOptions = {
        entities: [PersistedUser],
        entityNamespace: new FakeNamespace(stub) as any,
        workflowNamespace: new FakeNamespace() as any,
        queueNamespace: new FakeNamespace() as any,
        singletonNamespace: new FakeNamespace() as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* PersistedUser.client
        const client = makeClient("42")
        const sharding = yield* Sharding.Sharding
        for (let index = 0; index < 4097; index++) {
          yield* client.Ping(void 0)
        }

        assert.isFalse(yield* sharding.reset(requestIds[0] as any))
        assert.isTrue(yield* sharding.reset(requestIds.at(-1)! as any))
        assert.deepStrictEqual(resets, [requestIds.at(-1)])
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect("retries a persisted request on a fresh stub, then fails with a PersistenceError", () => {
      const invokedOn: Array<object> = []
      const entityNamespace = new FreshNamespace(() => {
        const stub = {
          invoke() {
            invokedOn.push(stub)
            return Promise.reject(transportError())
          }
        }
        return stub
      })
      const options: CloudflareCluster.LayerOptions = {
        ...makeOptions().options,
        entities: [PersistedUser],
        entityNamespace: entityNamespace as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* PersistedUser.client
        const error = yield* withTestClock(Effect.flip(makeClient("42").Ping(void 0)))

        assert.instanceOf(error, PersistenceError)
        assert.isAbove(invokedOn.length, 1)
        assert.strictEqual(new Set(invokedOn).size, invokedOn.length)
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect("fails a non-persisted request with a PersistenceError without retrying", () => {
      let invoked = 0
      const stub = {
        invoke() {
          invoked++
          return Promise.reject(transportError())
        }
      }

      return Effect.gen(function*() {
        const makeClient = yield* User.client
        const error = yield* withTestClock(Effect.flip(makeClient("42").Ping(void 0)))

        assert.instanceOf(error, PersistenceError)
        assert.strictEqual(invoked, 1)
      }).pipe(Effect.provide(CloudflareCluster.layer(makeOptions(stub).options)))
    })

    it.effect("does not interrupt the Durable Object for a client-uninterruptible request", () => {
      const interrupts: Array<string> = []
      let accepted!: () => void
      const acceptedPromise = new Promise<void>((resolve) => {
        accepted = resolve
      })
      const stub = {
        invoke(envelopeText: string) {
          accepted()
          // Accepted, with the reply still pending.
          return Promise.resolve({ _tag: "Success", requestId: JSON.parse(envelopeText).requestId, replies: [] })
        },
        interrupt(requestId: string) {
          interrupts.push(requestId)
          return Promise.resolve()
        }
      }
      const options: CloudflareCluster.LayerOptions = {
        ...makeOptions().options,
        entities: [ClientUninterruptible],
        entityNamespace: new FakeNamespace(stub) as any
      }

      return Effect.gen(function*() {
        const makeClient = yield* ClientUninterruptible.client
        const fiber = yield* Effect.forkChild(makeClient("42").Ping(void 0))
        yield* Effect.promise(() => acceptedPromise)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* Fiber.interrupt(fiber)

        assert.deepStrictEqual(interrupts, [])
      }).pipe(Effect.provide(CloudflareCluster.layer(options)))
    })

    it.effect.skipIf(forceGc === undefined)("releases a request's client state when its send fails", () => {
      const outcomes: Array<(requestId: string) => Promise<unknown>> = [
        () => Promise.resolve({ _tag: "MailboxFull" }),
        () => Promise.reject(transportError()),
        (requestId) => Promise.resolve({ _tag: "Success", requestId, replies: ["not a reply"] })
      ]
      let call = 0
      const stub = {
        invoke(envelopeText: string) {
          return outcomes[call++](JSON.parse(envelopeText).requestId)
        }
      }

      return Effect.gen(function*() {
        const makeClient = yield* User.client
        const client = makeClient("42")
        // Each request carries a context that only it references.
        const refs: Array<WeakRef<object>> = []
        const tracked = () => {
          const marker = {}
          refs.push(new WeakRef(marker))
          return Context.make(Marker, marker)
        }
        for (let index = 0; index < outcomes.length; index++) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(client.Ping(void 0, { context: tracked() }))))
        }
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        forceGc!()

        assert.deepStrictEqual(refs.map((ref) => ref.deref() === undefined), [true, true, true])
      }).pipe(Effect.provide(CloudflareCluster.layer(makeOptions(stub).options)))
    })

    it.effect("dies on getSnowflake as not supported", () =>
      Effect.gen(function*() {
        const sharding = yield* Sharding.Sharding
        const exit = yield* Effect.exit(sharding.getSnowflake)

        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
        assert.match(String(Cause.squash((exit as Exit.Failure<never, never>).cause)), /not supported/)
      }).pipe(Effect.provide(CloudflareCluster.layer(makeOptions().options))))

    it.effect("fails for an entity type not bound at Worker init", () =>
      Effect.gen(function*() {
        const { entityNamespace, options } = makeOptions()
        const exit = yield* Counter.client.pipe(
          Effect.provide(CloudflareCluster.layer(options)),
          Effect.exit
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.deepStrictEqual(entityNamespace.names, [])
      }))

    it.effect("ignores duplicate handler registration", () =>
      Effect.gen(function*() {
        const { options } = makeOptions()
        const handlers = User.toLayer({ Ping: () => Effect.succeed("pong") })
        yield* Layer.build(
          Layer.merge(handlers, User.toLayer({ Ping: () => Effect.succeed("pong2") })).pipe(
            Layer.provide(CloudflareCluster.layer(options))
          )
        )
      }))

    it.effect("fails when registering an entity type not bound at Worker init", () =>
      Effect.gen(function*() {
        const { options } = makeOptions()
        const exit = yield* Layer.build(
          Counter.toLayer({ Increment: () => Effect.void }).pipe(
            Layer.provide(CloudflareCluster.layer(options))
          )
        ).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit))
      }))
  })
})
