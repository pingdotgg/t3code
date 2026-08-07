import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * Resume a paused App Runner {@link Service} from a Lambda (or other AWS
 * runtime). App Runner re-provisions compute capacity and the endpoint
 * starts serving again. The call is asynchronous; pair with
 * {@link ListOperations} to track the returned `OperationId`.
 *
 * Provide `AppRunner.ResumeServiceHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * @binding
 * @section Pausing and Resuming
 * @example Resume a paused service
 * ```typescript
 * const resumeService = yield* AppRunner.ResumeService(service);
 * const { Service: resumed } = yield* resumeService();
 * // resumed.Status -> "OPERATION_IN_PROGRESS" (settles to "RUNNING")
 * ```
 */
export interface ResumeService extends Binding.Service<
  ResumeService,
  "AWS.AppRunner.ResumeService",
  (
    service: Service,
  ) => Effect.Effect<
    () => Effect.Effect<
      apprunner.ResumeServiceResponse,
      apprunner.ResumeServiceError
    >
  >
> {}
export const ResumeService = Binding.Service<ResumeService>(
  "AWS.AppRunner.ResumeService",
);
