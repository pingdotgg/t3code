import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { httpApiHandlers, rpcHandlers } from "./handlers.ts";
import { TaskApi, TaskRpcs } from "./schema.ts";

// Every class here ships the same module; `handler` names the export each
// image runs.

/** Sidecar serving Effect RPC. */
export class RpcSidecar extends GCP.Run.Container<RpcSidecar>()(
  "RpcSidecar",
  { main: import.meta.url, handler: "RpcSidecar", port: 3000, startupProbe: { tcpSocket: {} } },
  Effect.gen(function* () {
    return { fetch: GCP.Run.ServeRpc(TaskRpcs, rpcHandlers("rpc sidecar")) };
  }),
) {}

/** Sidecar serving an HttpApi. */
export class ApiSidecar extends GCP.Run.Container<ApiSidecar>()(
  "ApiSidecar",
  { main: import.meta.url, handler: "ApiSidecar", port: 3001, startupProbe: { tcpSocket: {} } },
  Effect.gen(function* () {
    return { fetch: GCP.Run.ServeHttpApi(TaskApi, httpApiHandlers("api sidecar")) };
  }),
) {}

/** Private service serving Effect RPC. */
export class RpcBackend extends GCP.Run.Service<RpcBackend>()(
  "RpcBackend",
  { main: import.meta.url, handler: "RpcBackend", location: "us-central1" },
  Effect.gen(function* () {
    return { fetch: GCP.Run.ServeRpc(TaskRpcs, rpcHandlers("rpc service")) };
  }),
) {}

/** Private service serving an HttpApi. */
export class ApiBackend extends GCP.Run.Service<ApiBackend>()(
  "ApiBackend",
  { main: import.meta.url, handler: "ApiBackend", location: "us-central1" },
  Effect.gen(function* () {
    return { fetch: GCP.Run.ServeHttpApi(TaskApi, httpApiHandlers("api service")) };
  }),
) {}
