import { Context, Effect, Layer, Schema } from "effect"
import { type Atom, AtomRpc } from "effect/unstable/reactivity"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import { describe, expect, it } from "tstyche"

describe("AtomRpc", () => {
  class ServerDependency extends Context.Service<
    ServerDependency,
    {}
  >()("ServerDependency") {}

  class RequiringMiddleware extends RpcMiddleware.Service<RequiringMiddleware, {
    requires: ServerDependency
  }>()("RequiringMiddleware", {}) {}

  const RequiringGroup = RpcGroup.make(
    Rpc.make("getUser", {
      success: Schema.Struct({
        id: Schema.Number,
        name: Schema.String
      })
    }).middleware(RequiringMiddleware)
  )

  it("query supports RPCs whose middleware declares service requirements", () => {
    const Client = AtomRpc.Service()("RequiringClient", {
      group: RequiringGroup,
      protocol: Layer.empty,
      makeEffect: Effect.die("unused")
    })

    const query = Client.query("getUser", undefined)

    expect<Atom.Success<typeof query>>().type.toBe<{
      readonly id: number
      readonly name: string
    }>()
  })
})
