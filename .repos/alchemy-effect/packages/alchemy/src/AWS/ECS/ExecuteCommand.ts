import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface ExecuteCommandRequest extends Omit<
  ECS.ExecuteCommandRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:ExecuteCommand` (ECS Exec).
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that starts a command against a running container in the bound
 * cluster. The cluster ARN is injected automatically and the host is granted
 * `ecs:ExecuteCommand` on the cluster and its tasks.
 *
 * The target task must have been launched with `enableExecuteCommand` and the
 * task role must allow the SSM messages channel. The response's
 * `session.tokenValue` is a `Redacted` bearer token for the SSM WebSocket
 * stream (`session.streamUrl`).
 * @binding
 * @section Executing Commands
 * @example Run a Command in a Container
 * ```typescript
 * const executeCommand = yield* AWS.ECS.ExecuteCommand(cluster);
 *
 * const response = yield* executeCommand({
 *   task: taskArn,
 *   command: "ls -al /",
 *   interactive: true,
 * });
 * const streamUrl = response.session?.streamUrl;
 * ```
 */
export interface ExecuteCommand extends Binding.Service<
  ExecuteCommand,
  "AWS.ECS.ExecuteCommand",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ExecuteCommandRequest,
    ) => Effect.Effect<ECS.ExecuteCommandResponse, ECS.ExecuteCommandError>
  >
> {}
export const ExecuteCommand = Binding.Service<ExecuteCommand>(
  "AWS.ECS.ExecuteCommand",
);
