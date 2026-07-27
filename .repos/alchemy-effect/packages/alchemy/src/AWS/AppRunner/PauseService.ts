import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * Pause an App Runner {@link Service} from a Lambda (or other AWS runtime).
 * App Runner releases the service's compute capacity (the endpoint stops
 * serving) while keeping its configuration — e.g. a nightly scheduler that
 * pauses non-production services to stop compute billing. The call is
 * asynchronous; pair with {@link ListOperations} or {@link ResumeService}.
 *
 * Provide `AppRunner.PauseServiceHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * @binding
 * @section Pausing and Resuming
 * @example Pause a service overnight
 * ```typescript
 * const pauseService = yield* AppRunner.PauseService(service);
 * const { Service: paused } = yield* pauseService();
 * // paused.Status -> "OPERATION_IN_PROGRESS" (settles to "PAUSED")
 * ```
 */
export interface PauseService extends Binding.Service<
  PauseService,
  "AWS.AppRunner.PauseService",
  (
    service: Service,
  ) => Effect.Effect<
    () => Effect.Effect<
      apprunner.PauseServiceResponse,
      apprunner.PauseServiceError
    >
  >
> {}
export const PauseService = Binding.Service<PauseService>(
  "AWS.AppRunner.PauseService",
);
