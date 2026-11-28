import { type Cause, type Effect, hole, type Queue, Schema, type Scope } from "effect"
import { Rpc, type RpcClient } from "effect/rpc"
import { describe, expect, it } from "tstyche"

const A = Rpc.make("A", { payload: { id: Schema.String }, success: Schema.Number })
const B = Rpc.make("B", { success: Schema.String })

describe("RpcClient.Flat", () => {
  it("infers a result per RPC for a union of tags", () => {
    const client = hole<RpcClient.RpcClient.Flat<typeof A | typeof B>>()

    expect(client(hole<"A" | "B">(), hole<{ readonly id: string } | void>())).type.toBe<
      Effect.Effect<number> | Effect.Effect<string>
    >()
  })

  it("ends an asQueue dequeue with Cause.Done", () => {
    const Events = Rpc.make("Events", { success: Schema.String, error: Schema.Number, stream: true })
    const client = hole<RpcClient.RpcClient.Flat<typeof Events>>()

    expect(client("Events", undefined, { asQueue: true })).type.toBe<
      Effect.Effect<Queue.Dequeue<string, number | Cause.Done>, never, Scope.Scope>
    >()
  })

  it("accepts a tag and payload forwarded from a generic caller", () => {
    type Rpcs = typeof A | typeof B
    const client = hole<RpcClient.RpcClient.Flat<Rpcs>>()
    const call = <Tag extends Rpc.Tag<Rpcs>>(
      tag: Tag,
      payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>
    ) => client(tag, payload)

    expect(call("A", { id: "a" })).type.toBe<Effect.Effect<number>>()
  })

  it("rejects non-string tags when the RPC tag is widened to string", () => {
    const Dynamic = Rpc.make("A" as string, { success: Schema.Number })
    const client = hole<RpcClient.RpcClient.Flat<typeof Dynamic>>()

    expect(client).type.not.toBeCallableWith(123, undefined)
  })
})
