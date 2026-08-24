import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Blueprint } from "./Blueprint.ts";

/**
 * `CreateBlueprintVersion` request with `blueprintArn` injected from the
 * bound {@link Blueprint}.
 */
export interface CreateBlueprintVersionRequest extends Omit<
  bda.CreateBlueprintVersionRequest,
  "blueprintArn"
> {}

/**
 * Runtime binding for the `CreateBlueprintVersion` operation (IAM action
 * `bedrock:CreateBlueprintVersion` on the blueprint ARN) — snapshot the
 * bound blueprint's current schema as an immutable version from a deployed
 * Function.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.CreateBlueprintVersionHttp)`.
 * @binding
 * @section Blueprint Management
 * @example Snapshot The Blueprint
 * ```typescript
 * // deploy time — bind the blueprint
 * const createVersion =
 *   yield* AWS.BedrockDataAutomation.CreateBlueprintVersion(blueprint);
 *
 * // runtime — freeze the current schema as a new version
 * const { blueprint: version } = yield* createVersion({});
 * yield* Effect.log(`created version ${version.blueprintVersion}`);
 * ```
 */
export interface CreateBlueprintVersion extends Binding.Service<
  CreateBlueprintVersion,
  "AWS.BedrockDataAutomation.CreateBlueprintVersion",
  (
    blueprint: Blueprint,
  ) => Effect.Effect<
    (
      request: CreateBlueprintVersionRequest,
    ) => Effect.Effect<
      bda.CreateBlueprintVersionResponse,
      bda.CreateBlueprintVersionError
    >
  >
> {}
export const CreateBlueprintVersion = Binding.Service<CreateBlueprintVersion>(
  "AWS.BedrockDataAutomation.CreateBlueprintVersion",
);
