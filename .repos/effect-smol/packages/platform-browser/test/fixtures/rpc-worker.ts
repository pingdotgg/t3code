import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { RpcLive } from "./rpc-schemas.ts"

const MainLive = RpcLive.pipe(
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

Effect.runFork(Layer.launch(MainLive))
