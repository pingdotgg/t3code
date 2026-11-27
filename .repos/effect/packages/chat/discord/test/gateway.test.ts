import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { assert, describe, it } from "@effect/vitest"
import * as DiscordConfig from "dfx/DiscordConfig"
import { DiscordWS, type MessageSend, Reconnect } from "dfx/DiscordGateway/DiscordWS"
import { MesssagingLive } from "dfx/DiscordGateway/Messaging"
import * as Shard from "dfx/DiscordGateway/Shard"
import { type ShardState, ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
import { MemoryRateLimitStoreLive, RateLimiterLive } from "dfx/RateLimit"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { ChatHandler, NotAccepted } from "effect/chat/ChatHandler"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import { discordLayer, events, makeFake } from "./utils.ts"

/** Storage that outlives a host: what a Durable Object keeps between evictions. */
type Storage = Map<string, ShardState>

const sessionStore = (storage: Storage) =>
  Layer.succeed(
    ShardStateStore,
    ShardStateStore.of({
      forShard: ([id, count]) => {
        const key = `${id}/${count}`
        return {
          get: Effect.sync(() => Option.fromUndefinedOr(storage.get(key))),
          set: (state) => Effect.sync(() => void storage.set(key, state)),
          clear: Effect.sync(() => void storage.delete(key))
        }
      }
    })
  )

const stored = (storage: Storage) => storage.get("0/1")

const hello = { op: 10, d: { heartbeat_interval: 41_250 } }
const ready = {
  op: 0,
  t: "READY",
  s: 1,
  d: { session_id: "session-1", resume_gateway_url: "wss://resume.example" }
}
const created = events("channel-message")[0]
const message = (s: number) => ({ op: 0, t: created.t, s, d: created.d })

/** Lets the shard's fibers run until `done`. */
const until = Effect.fnUntraced(function*(done: () => boolean) {
  for (let i = 0; i < 1000 && !done(); i++) yield* Effect.yieldNow
  assert.isTrue(done(), "the shard did not get there")
})

/**
 * One host: dfx's real shard over a socket the test drives, with
 * `layerDispatchHook` and `storage` behind it. Closing the scope stops the
 * host, as an eviction does.
 */
const host = Effect.fnUntraced(function*(
  storage: Storage,
  handle: (event: ChatEvent.ChatEvent) => Effect.Effect<void, NotAccepted>
) {
  const inbound = yield* Queue.unbounded<any>()
  const written: Array<MessageSend> = []
  let onConnecting: Effect.Effect<void> = Effect.void
  const socket = Layer.succeed(
    DiscordWS,
    DiscordWS.of({
      connect: (options) =>
        Effect.sync(() => {
          onConnecting = options.onConnecting
          return {
            take: Queue.take(inbound),
            setUrl: () => Effect.void,
            write: (sent) => Effect.sync(() => void written.push(sent))
          }
        })
    })
  )
  const context = yield* Layer.build(
    Layer.effect(Shard.Shard, Shard.make).pipe(
      Layer.provide([socket, MesssagingLive, RateLimiterLive, sessionStore(storage), DiscordChat.layerDispatchHook]),
      Layer.provide([
        MemoryRateLimitStoreLive,
        DiscordConfig.layer({ token: Redacted.make("token") }),
        Layer.succeed(ChatHandler, ChatHandler.of({ handle })),
        discordLayer(makeFake({}))
      ])
    )
  )
  yield* Context.get(context, Shard.Shard).connect([0, 1]).pipe(
    Effect.provideService(Socket.WebSocketConstructor, () => {
      throw new Error("the test drives the socket")
    })
  )
  /** What the shard wrote with `op`: 2 is IDENTIFY and 6 RESUME. */
  const sent = (op: number): Array<any> =>
    written.filter((payload): payload is Exclude<MessageSend, Reconnect> => payload !== Reconnect).filter((payload) =>
      payload.op === op
    ).map((payload) => payload.d)
  return {
    receive: (payload: unknown) => Queue.offer(inbound, payload),
    sent,
    reconnects: () => written.filter((payload) => payload === Reconnect).length,
    /** The socket opened again, as dfx's does after it drops the connection. */
    reopened: Effect.suspend(() => onConnecting)
  }
})

describe("layerDispatchHook", () => {
  it.effect("a host built again resumes the stored session, having handled each event before its sequence was stored", () => {
    const storage: Storage = new Map()
    const seen: Array<{ readonly id: string; readonly storedSequence: number | null | undefined }> = []
    const handle = (event: ChatEvent.ChatEvent) =>
      Effect.sync(() => {
        if (event._tag === "MessageCreated") {
          seen.push({ id: event.message.id, storedSequence: stored(storage)?.sequence })
        }
      })
    return Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const first = yield* host(storage, handle)
        yield* first.receive(hello)
        yield* until(() => first.sent(2).length === 1)
        assert.strictEqual(first.sent(6).length, 0)
        yield* first.receive(ready)
        yield* first.receive(message(2))
        yield* until(() => stored(storage)?.sequence === 2)
        assert.deepStrictEqual(seen, [{ id: created.d.id, storedSequence: 1 }])
      }))
      assert.deepStrictEqual(stored(storage), {
        sessionId: "session-1",
        resumeUrl: "wss://resume.example",
        sequence: 2
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const second = yield* host(storage, handle)
        yield* second.receive(hello)
        yield* until(() => second.sent(6).length === 1)
        assert.deepStrictEqual(second.sent(6), [{ token: "token", session_id: "session-1", seq: 2 }])
        assert.strictEqual(second.sent(2).length, 0)
      }))
    })
  })

  it.effect("an event refused with NotAccepted is not stored and comes back with the RESUME", () => {
    const storage: Storage = new Map()
    let attempts = 0
    const handle = () => Effect.suspend(() => attempts++ === 0 ? Effect.fail(new NotAccepted()) : Effect.void)
    return Effect.scoped(Effect.gen(function*() {
      const gateway = yield* host(storage, handle)
      yield* gateway.receive(hello)
      yield* gateway.receive(ready)
      yield* until(() => stored(storage)?.sequence === 1)
      yield* gateway.receive(message(2))
      yield* until(() => gateway.reconnects() === 1)
      assert.strictEqual(attempts, 1)
      assert.strictEqual(stored(storage)?.sequence, 1)
      // dfx waits a second after the first failure before it resumes.
      yield* gateway.reopened
      yield* gateway.receive(hello)
      yield* TestClock.adjust("1 second")
      yield* until(() => gateway.sent(6).length === 1)
      assert.deepStrictEqual(gateway.sent(6), [{ token: "token", session_id: "session-1", seq: 1 }])
      // Discord replays what came after sequence 1.
      yield* gateway.receive(message(2))
      yield* until(() => stored(storage)?.sequence === 2)
      assert.strictEqual(attempts, 2)
      assert.strictEqual(gateway.reconnects(), 1)
    }))
  })

  it.effect("a handler defect is logged and the event dropped, so the events after it still arrive", () => {
    const storage: Storage = new Map()
    let handled = 0
    const handle = () => Effect.suspend(() => handled++ === 0 ? Effect.die(new Error("bug")) : Effect.void)
    return Effect.scoped(Effect.gen(function*() {
      const gateway = yield* host(storage, handle)
      yield* gateway.receive(hello)
      yield* gateway.receive(ready)
      yield* gateway.receive(message(2))
      yield* gateway.receive(message(3))
      yield* until(() => stored(storage)?.sequence === 3)
      assert.strictEqual(handled, 2)
      assert.strictEqual(gateway.reconnects(), 0)
    }))
  })
})
