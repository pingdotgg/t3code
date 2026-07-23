/**
 * The `WorkflowProxy` module derives transport contracts from durable
 * `Workflow` definitions.
 *
 * Use it when workflows should be invoked through RPC or HTTP instead of by
 * importing the workflow implementation directly. `toRpcGroup` creates the
 * `RpcGroup` that RPC clients and servers share, while `toHttpApiGroup` creates
 * the `HttpApiGroup` that can be mounted in an HTTP API. Each workflow expands
 * into execute, discard, and resume operations so external callers can start a
 * workflow, start it through the discard path, or resume a suspended execution
 * by `executionId`.
 *
 * The generated names and schemas come from the workflow definitions, so keep
 * workflow names stable and pass the same workflow list to the matching
 * `WorkflowProxyServer` layer. RPC proxies may be prefixed, but the same prefix
 * must be used by the server handlers. HTTP endpoint paths are derived from the
 * lower-cased workflow name. Preserve workflow arrays as const tuples when you
 * want the generated RPC and HTTP API types to retain each workflow's literal
 * name, payload, success, and error types.
 *
 * Discard and resume are control operations rather than ordinary workflow
 * result reads. The discard proxy does not expose the normal success or error
 * schemas, and resume expects the persisted `executionId`; it cannot recreate
 * that boundary value from the original payload.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Schema from "../../Schema.ts"
import * as HttpApiEndpoint from "../httpapi/HttpApiEndpoint.ts"
import * as HttpApiGroup from "../httpapi/HttpApiGroup.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import type * as Workflow from "./Workflow.ts"

/**
 * Derives an `RpcGroup` from a list of workflows.
 *
 * **Example** (Deriving RPC endpoints from workflows)
 *
 * ```ts
 * import { Layer, Schema } from "effect"
 * import { RpcServer } from "effect/unstable/rpc"
 * import { Workflow, WorkflowProxy, WorkflowProxyServer } from "effect/unstable/workflow"
 *
 * const EmailWorkflow = Workflow.make({
 *   name: "EmailWorkflow",
 *   payload: {
 *     id: Schema.String,
 *     to: Schema.String
 *   },
 *   idempotencyKey: ({ id }) => id
 * })
 *
 * const myWorkflows = [EmailWorkflow] as const
 *
 * // Use WorkflowProxy.toRpcGroup to create a `RpcGroup` from the
 * // workflows
 * class MyRpcs extends WorkflowProxy.toRpcGroup(myWorkflows) {}
 *
 * // Use WorkflowProxyServer.layerRpcHandlers to create a layer that implements
 * // the rpc handlers
 * const ApiLayer = RpcServer.layer(MyRpcs).pipe(
 *   Layer.provide(WorkflowProxyServer.layerRpcHandlers(myWorkflows))
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const toRpcGroup = <
  const Workflows extends NonEmptyReadonlyArray<Workflow.Any>,
  const Prefix extends string = ""
>(
  workflows: Workflows,
  options?: {
    readonly prefix?: Prefix | undefined
  }
): RpcGroup.RpcGroup<ConvertRpcs<Workflows[number], Prefix>> => {
  const prefix = options?.prefix ?? ""
  const rpcs: Array<Rpc.Any> = []
  for (const workflow_ of workflows) {
    const workflow = workflow_ as Workflow.AnyWithProps
    rpcs.push(
      Rpc.make(`${prefix}${workflow.name}`, {
        payload: workflow.payloadSchema,
        error: workflow.errorSchema,
        success: workflow.successSchema
      }).annotateMerge(workflow.annotations),
      Rpc.make(`${prefix}${workflow.name}Discard`, {
        payload: workflow.payloadSchema
      }).annotateMerge(workflow.annotations),
      Rpc.make(`${prefix}${workflow.name}Resume`, { payload: ResumePayload })
        .annotateMerge(workflow.annotations)
    )
  }
  return RpcGroup.make(...rpcs) as any
}

/**
 * Maps each workflow to the RPC definitions generated for execute, discard,
 * and resume operations.
 *
 * @category converting
 * @since 4.0.0
 */
export type ConvertRpcs<Workflows extends Workflow.Any, Prefix extends string> = Workflows extends Workflow.Workflow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | Rpc.Rpc<`${Prefix}${_Name}`, _Payload, _Success, _Error>
    | Rpc.Rpc<`${Prefix}${_Name}Discard`, _Payload>
    | Rpc.Rpc<`${Prefix}${_Name}Resume`, typeof ResumePayload>
  : never

/**
 * Derives an `HttpApiGroup` from a list of workflows.
 *
 * **Example** (Deriving HTTP API endpoints from workflows)
 *
 * ```ts
 * import { Layer, Schema } from "effect"
 * import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
 * import { Workflow, WorkflowProxy, WorkflowProxyServer } from "effect/unstable/workflow"
 *
 * const EmailWorkflow = Workflow.make({
 *   name: "EmailWorkflow",
 *   payload: {
 *     id: Schema.String,
 *     to: Schema.String
 *   },
 *   idempotencyKey: ({ id }) => id
 * })
 *
 * const myWorkflows = [EmailWorkflow] as const
 *
 * // Use WorkflowProxy.toHttpApiGroup to create a `HttpApiGroup` from the
 * // workflows
 * class MyApi extends HttpApi.make("api")
 *   .add(WorkflowProxy.toHttpApiGroup("workflows", myWorkflows))
 * {}
 *
 * // Use WorkflowProxyServer.layerHttpApi to create a layer that implements the
 * // workflows HttpApiGroup
 * const ApiLayer = HttpApiBuilder.layer(MyApi).pipe(
 *   Layer.provide(
 *     WorkflowProxyServer.layerHttpApi(MyApi, "workflows", myWorkflows)
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const toHttpApiGroup = <const Name extends string, const Workflows extends NonEmptyReadonlyArray<Workflow.Any>>(
  name: Name,
  workflows: Workflows
): HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Workflows[number]>> => {
  let group = HttpApiGroup.make(name)
  for (const workflow_ of workflows) {
    const workflow = workflow_ as Workflow.AnyWithProps
    const path = `/${tagToPath(workflow.name)}` as const
    group = group.add(
      HttpApiEndpoint.post(workflow.name, path, {
        payload: workflow.payloadSchema,
        success: workflow.successSchema,
        error: workflow.errorSchema
      }).annotateMerge(workflow.annotations),
      HttpApiEndpoint.post(workflow.name + "Discard", `${path}/discard`, {
        payload: workflow.payloadSchema
      }).annotateMerge(workflow.annotations),
      HttpApiEndpoint.post(workflow.name + "Resume", `${path}/resume`, {
        payload: ResumePayload
      }).annotateMerge(workflow.annotations)
    ) as any
  }
  return group as any
}

const tagToPath = (tag: string): string =>
  tag
    // .replace(/[^a-zA-Z0-9]+/g, "-") // Replace non-alphanumeric characters with hyphen
    // .replace(/([a-z])([A-Z])/g, "$1-$2") // Insert hyphen before uppercase letters
    .toLowerCase()

/**
 * Maps each workflow to the HTTP API endpoints generated for execute,
 * discard, and resume operations.
 *
 * @category converting
 * @since 4.0.0
 */
export type ConvertHttpApi<Workflows extends Workflow.Any> = Workflows extends Workflow.Workflow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | HttpApiEndpoint.HttpApiEndpoint<
      _Name,
      "POST",
      `/${Lowercase<_Name>}`,
      never,
      never,
      _Payload,
      never,
      _Success,
      _Error
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Discard`,
      "POST",
      `/${Lowercase<_Name>}/discard`,
      never,
      never,
      _Payload
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Resume`,
      "POST",
      `/${Lowercase<_Name>}/resume`,
      never,
      never,
      typeof ResumePayload
    > :
  never

const ResumePayload = Schema.Struct({ executionId: Schema.String })
