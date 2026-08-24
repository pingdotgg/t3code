import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * `GetConsoleOutput` request with `InstanceId` injected from the bound
 * {@link Instance}.
 */
export interface GetConsoleOutputRequest extends Omit<
  ec2.GetConsoleOutputRequest,
  "InstanceId" | "InstanceIds"
> {}

/**
 * Runtime binding for the `GetConsoleOutput` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:GetConsoleOutput` on the instance ARN).
 *
 * Fetches the instance's serial console output (base64-encoded) — e.g. a
 * diagnostics Lambda that captures boot logs when a host fails its health
 * checks. Pass `Latest: true` for the most recent output on supported
 * instance types. Provide the implementation with
 * `Effect.provide(AWS.EC2.GetConsoleOutputHttp)`.
 * @binding
 * @section Diagnostics
 * @example Capture the instance's console output
 * ```typescript
 * // init — bind the operation to the instance
 * const getConsoleOutput = yield* AWS.EC2.GetConsoleOutput(instance);
 *
 * // runtime — fetch the (base64-encoded) boot log
 * const result = yield* getConsoleOutput({ Latest: true });
 * const log = Buffer.from(result.Output ?? "", "base64").toString("utf8");
 * ```
 */
export interface GetConsoleOutput extends Binding.Service<
  GetConsoleOutput,
  "AWS.EC2.GetConsoleOutput",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetConsoleOutputRequest,
    ) => Effect.Effect<ec2.GetConsoleOutputResult, ec2.GetConsoleOutputError>
  >
> {}

export const GetConsoleOutput = Binding.Service<GetConsoleOutput>(
  "AWS.EC2.GetConsoleOutput",
);
