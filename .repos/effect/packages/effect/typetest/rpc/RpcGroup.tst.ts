import type { Cause, Queue, Stream } from "effect"
import { Context, Deferred, Effect, Schema } from "effect"
import type * as Layer from "effect/Layer"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as RpcMiddleware from "effect/rpc/RpcMiddleware"
import { describe, expect, it } from "tstyche"

class Db extends Context.Service<Db, {
  readonly value: string
}>()("Db") {}

class Metrics extends Context.Service<Metrics, {
  readonly value: string
}>()("Metrics") {}

const GetUser = Rpc.make("GetUser", { success: Schema.String })
const UpdateUser = Rpc.make("UpdateUser", { success: Schema.String })
const Group = RpcGroup.make(GetUser, UpdateUser)

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {}
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
class Unknown extends Schema.TaggedError<Unknown>()("Unknown", {}) {}
class ClientFailure extends Schema.TaggedError<ClientFailure>()("ClientFailure", {}) {}

class Authn extends RpcMiddleware.Service<Authn, { clientError: ClientFailure }>()("Authn", { error: Unauthorized }) {}
class Authz extends RpcMiddleware.Service<Authz>()("Authz", { error: Forbidden }) {}

const Find = Rpc.make("Find", { success: Schema.String, error: NotFound })
const Events = Rpc.make("Events", { success: Schema.String, error: NotFound, stream: true })
const GuardedGroup = RpcGroup.make(Find, Events).middleware(Authn).middleware(Authz)

type GuardedError = NotFound | Unauthorized | Forbidden
declare const find: Effect.Effect<string, GuardedError>
declare const events: Stream.Stream<string, GuardedError>
declare const eventsQueue: Effect.Effect<Queue.Dequeue<string, GuardedError | Cause.Done>, GuardedError>

describe("RpcGroup", () => {
  it("toLayer includes handler dependencies in layer services", () => {
    const layer = Group.toLayer({
      GetUser: () => Db.use((db) => Effect.succeed(db.value)),
      UpdateUser: () => Db.use((db) => Effect.succeed(db.value))
    })

    type HasExpectedServices = [Layer.Services<typeof layer>] extends [Db] ?
      ([Db] extends [Layer.Services<typeof layer>] ? true : false) :
      false

    expect<HasExpectedServices>().type.toBe<true>()
  })

  it("toLayer includes handler dependencies from effect-built handlers", () => {
    const layer = Group.toLayer(Effect.succeed({
      GetUser: () => Db.use((db) => Effect.succeed(db.value)),
      UpdateUser: () => Db.use((db) => Effect.succeed(db.value))
    }))

    type HasExpectedServices = [Layer.Services<typeof layer>] extends [Db] ?
      ([Db] extends [Layer.Services<typeof layer>] ? true : false) :
      false

    expect<HasExpectedServices>().type.toBe<true>()
  })

  it("toLayerHandler includes handler dependencies in layer services", () => {
    const layer = Group.toLayerHandler("GetUser", () => Metrics.use((metrics) => Effect.succeed(metrics.value)))

    type HasExpectedServices = [Layer.Services<typeof layer>] extends [Metrics] ?
      ([Metrics] extends [Layer.Services<typeof layer>] ? true : false) :
      false

    expect<HasExpectedServices>().type.toBe<true>()
  })

  it("omit removes an rpc", () => {
    const group = Group.omit("GetUser")
    type Tags = RpcGroup.Rpcs<typeof group>["_tag"]
    expect<Tags>().type.toBe<"UpdateUser">()
  })

  describe("handler errors", () => {
    it("toLayer accepts handlers failing with rpc and middleware errors", () => {
      expect(GuardedGroup.toLayer).type.toBeCallableWith({ Find: () => find, Events: () => events })
      expect(GuardedGroup.toLayer).type.toBeCallableWith({
        Find: () => Deferred.make<string, NotFound>(),
        Events: () => eventsQueue
      })
    })

    it("toLayer rejects errors not declared by the rpc or its server middleware", () => {
      expect(GuardedGroup.toLayer).type.not.toBeCallableWith({
        Find: () => Effect.fail(new Unknown()),
        Events: () => events
      })
      expect(GuardedGroup.toLayer).type.not.toBeCallableWith({
        Find: () => Effect.fail(new ClientFailure()),
        Events: () => events
      })
      expect(RpcGroup.make(Find).toLayer).type.not.toBeCallableWith({
        Find: () => Effect.fail(new Unauthorized())
      })
    })
  })
})
