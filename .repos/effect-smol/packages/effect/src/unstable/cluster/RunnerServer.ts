/**
 * Provides server-side layers for the cluster runner protocol.
 *
 * Runner protocol handlers receive ping, notification, request, stream, and
 * envelope messages from other runners. They forward those messages into
 * `Sharding` and coordinate persisted replies through `MessageStorage`. This
 * module includes the handler layer, a transport-independent RPC server layer, a
 * full server layer that also provides runner clients, and a client-only layer
 * for applications that do not serve runner RPCs.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { constant } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Queue from "../../Queue.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import type * as ClusterError from "./ClusterError.ts"
import * as Message from "./Message.ts"
import * as MessageStorage from "./MessageStorage.ts"
import * as Reply from "./Reply.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import type * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import { ShardingConfig } from "./ShardingConfig.ts"

const constVoid = constant(Effect.void)

/**
 * Layer that handles runner protocol RPCs by forwarding requests to `Sharding`
 * and `MessageStorage`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerHandlers = Runners.Rpcs.toLayer(Effect.gen(function*() {
  const sharding = yield* Sharding.Sharding
  const storage = yield* MessageStorage.MessageStorage

  return {
    Ping: () => Effect.void,
    Notify: ({ envelope }) =>
      sharding.notify(
        envelope._tag === "Request"
          ? new Message.IncomingRequest({
            envelope,
            respond: constVoid,
            lastSentReply: Option.none()
          })
          : new Message.IncomingEnvelope({ envelope })
      ),
    Effect: ({ persisted, request }) => {
      let replyEncoded: Option.Option<Effect.Effect<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>> = Option
        .none()
      let resume = (reply: Effect.Effect<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>) => {
        replyEncoded = Option.some(reply)
      }
      const message = new Message.IncomingRequest({
        envelope: request,
        lastSentReply: Option.none(),
        respond(reply) {
          resume(Effect.orDie(Reply.serialize(reply)))
          return Effect.void
        }
      })
      if (persisted) {
        return Effect.callback<
          Reply.Encoded,
          ClusterError.EntityNotAssignedToRunner
        >((resume_) => {
          resume = resume_
          const parent = Fiber.getCurrent()!
          const onExit = (
            exit: Exit.Exit<
              any,
              ClusterError.EntityNotAssignedToRunner
            >
          ) => {
            if (exit._tag === "Failure") {
              resume(exit as any)
            }
          }
          const runFork = Effect.runForkWith(parent.context)
          const fiber = runFork(storage.registerReplyHandler(message))
          fiber.addObserver(onExit)
          runFork(Effect.catchTag(
            sharding.notify(message, constWaitUntilRead),
            "AlreadyProcessingMessage",
            () => Effect.void
          )).addObserver(onExit)
          return Fiber.interrupt(fiber)
        })
      }
      return Effect.andThen(
        sharding.send(message),
        Effect.callback<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>((resume_) => {
          if (Option.isSome(replyEncoded)) {
            resume_(replyEncoded.value)
          } else {
            resume = resume_
          }
        })
      )
    },
    Stream: ({ persisted, request }) =>
      Effect.flatMap(
        Queue.make<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>(),
        (queue) => {
          const message = new Message.IncomingRequest({
            envelope: request,
            lastSentReply: Option.none(),
            respond(reply) {
              return Effect.flatMap(Reply.serialize(reply), (reply) => {
                Queue.offerUnsafe(queue, reply)
                return Effect.void
              })
            }
          })
          return Effect.as(
            persisted ?
              Effect.andThen(
                storage.registerReplyHandler(message).pipe(
                  Effect.onError((cause) => Queue.failCause(queue, cause)),
                  Effect.forkScoped
                ),
                sharding.notify(message, constWaitUntilRead)
              ) :
              sharding.send(message),
            queue
          )
        }
      ),
    Envelope: ({ envelope }) => sharding.send(new Message.IncomingEnvelope({ envelope }))
  }
}))

const constWaitUntilRead = { waitUntilRead: true } as const

/**
 * Creates the runner RPC server layer, which receives messages from other
 * runners, forwards them to the `Sharding` layer, and responds to `Ping`
 * requests.
 *
 * **When to use**
 *
 * Use when a runner process should accept runner-to-runner protocol messages
 * over a provided server `RpcServer.Protocol`.
 *
 * **Gotchas**
 *
 * This layer does not choose or provide the wire transport; provide a
 * transport-specific `RpcServer.Protocol` separately.
 *
 * @see {@link layerHandlers} for the lower-level handler layer used when the RPC server is supplied elsewhere
 * @see {@link layerWithClients} for a runner server layer that also provides the `Sharding` and `Runners` clients
 * @see {@link layerClientOnly} for embedding a cluster client without serving runner RPCs
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  never,
  never,
  RpcServer.Protocol | Sharding.Sharding | MessageStorage.MessageStorage
> = RpcServer.layer(Runners.Rpcs, {
  spanPrefix: "RunnerServer",
  disableTracing: true
}).pipe(Layer.provide(layerHandlers))

/**
 * Layer that provides `RunnerServer` together with `Runners` and `Sharding`
 * clients.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWithClients: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | RpcServer.Protocol
  | ShardingConfig
  | Runners.RpcClientProtocol
  | MessageStorage.MessageStorage
  | RunnerStorage.RunnerStorage
  | RunnerHealth.RunnerHealth
> = layer.pipe(
  Layer.provideMerge(Sharding.layer),
  Layer.provideMerge(Runners.layerRpc)
)

/**
 * Creates a client-only `Runners` layer.
 *
 * **When to use**
 *
 * Use to embed a cluster client inside another Effect application without registering with
 * the ShardManager or receiving shard assignments.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerClientOnly: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | ShardingConfig
  | Runners.RpcClientProtocol
  | MessageStorage.MessageStorage
  | RunnerStorage.RunnerStorage
> = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerRpc),
  Layer.provide(RunnerHealth.layerNoop),
  Layer.updateService(ShardingConfig, (config) => ({
    ...config,
    runnerAddress: Option.none()
  }))
)
