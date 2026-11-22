import * as Effect from "effect/Effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import * as SharedMemory from "effect/workers/SharedMemory"

export const Compute = RpcGroup.make(
  Rpc.make("Fill", { payload: { data: SharedMemory.schema(Int32Array), from: Schema.Number, to: Schema.Number } })
)

export const ComputeLive = Compute.toLayer({
  Fill: ({ data, from, to }) =>
    Effect.sync(() => {
      for (let i = from; i < to; i++) data[i] = i * 2
    })
})
