import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import { Compute, ComputeLive } from "./shared-memory-rpc.ts"

RpcServer.layer(Compute).pipe(
  Layer.provide(ComputeLive),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
