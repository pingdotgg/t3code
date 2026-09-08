import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Atom, AtomRegistry, AtomRpc, Hydration } from "effect/unstable/reactivity"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const Group = RpcGroup.make(
  Rpc.make("getUser", {
    payload: Schema.Struct({
      id: Schema.FiniteFromString
    }),
    success: Schema.Struct({
      id: Schema.Number,
      name: Schema.String
    })
  })
)

describe("AtomRpc", () => {
  it.effect("query creates a serializable atom with reactivity and retention", () =>
    Effect.gen(function*() {
      const Client = AtomRpc.Service()("Client", {
        group: Group,
        protocol: Layer.empty,
        makeEffect: Effect.succeed(
          ((tag: string, payload: { readonly id: number }) => {
            if (tag !== "getUser") {
              return Effect.die(`unexpected tag: ${tag}`)
            }
            return Effect.succeed({
              id: payload.id,
              name: `user-${payload.id}`
            })
          }) as any
        )
      })

      const atom = Client.query("getUser", { id: 1 }, {
        headers: {
          "x-id": "abc"
        },
        reactivityKeys: ["users"],
        timeToLive: "1 minute",
        serializationKey: "1"
      })

      assert.deepStrictEqual(
        {
          idleTTL: atom.idleTTL,
          serializable: Atom.isSerializable(atom)
        },
        {
          idleTTL: 60_000,
          serializable: true
        }
      )
      const keepAliveAtom = Client.query("getUser", { id: 2 }, {
        reactivityKeys: ["users"],
        timeToLive: "Infinity",
        serializationKey: "keep-alive"
      })
      assert.deepStrictEqual(
        {
          keepAlive: keepAliveAtom.keepAlive,
          serializable: Atom.isSerializable(keepAliveAtom)
        },
        {
          keepAlive: true,
          serializable: true
        }
      )
      if (!Atom.isSerializable(atom)) {
        assert.fail("expected query atom to be serializable")
      }
      const key = atom[Atom.SerializableTypeId].key

      const atomFromEncodedPayload = Client.query("getUser", { id: 1 }, {
        headers: {
          "x-id": "abc"
        },
        reactivityKeys: ["users"],
        timeToLive: "1 minute",
        serializationKey: "1"
      })
      assert(Atom.isSerializable(atomFromEncodedPayload), "expected query atom from encoded payload to be serializable")
      assert(atom === atomFromEncodedPayload)
      assert.strictEqual(atomFromEncodedPayload[Atom.SerializableTypeId].key, key)

      const registry = AtomRegistry.make()
      const unmount = registry.mount(atom)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      const dehydrated = Hydration.toValues(Hydration.dehydrate(registry))
      assert.lengthOf(dehydrated, 1)
      assert.strictEqual(dehydrated[0]!.key, key)

      unmount()
    }))
})
