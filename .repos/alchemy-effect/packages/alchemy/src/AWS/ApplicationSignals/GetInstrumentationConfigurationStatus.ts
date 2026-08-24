import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InstrumentationConfiguration } from "./InstrumentationConfiguration.ts";

/**
 * `GetInstrumentationConfigurationStatus` request with the configuration's
 * identity (`InstrumentationType`/`Service`/`Environment`/`SignalType`/
 * `LocationIdentifier`) injected from the bound
 * {@link InstrumentationConfiguration}.
 */
export interface GetInstrumentationConfigurationStatusRequest extends Omit<
  appsignals.GetInstrumentationConfigurationStatusRequest,
  | "InstrumentationType"
  | "Service"
  | "Environment"
  | "SignalType"
  | "LocationIdentifier"
> {}

/**
 * Runtime binding for
 * `application-signals:GetInstrumentationConfigurationStatus`, scoped to
 * one {@link InstrumentationConfiguration}.
 *
 * Returns the status history (`READY`/`ERROR`/`ACTIVE`/`DISABLED`) that
 * instrumented SDK agents reported for the bound configuration during a
 * time range. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.GetInstrumentationConfigurationStatusHttp)`.
 * @binding
 * @section Monitoring Instrumentation
 * @example Check Whether the Probe Applied
 * ```typescript
 * // init — bind the operation to the configuration
 * const getStatus =
 *   yield* AWS.ApplicationSignals.GetInstrumentationConfigurationStatus(probe);
 *
 * // runtime — the configuration's identity is injected automatically
 * const result = yield* getStatus({ Status: "ACTIVE" });
 * yield* Effect.log(`${result.Events.length} ACTIVE events`);
 * ```
 */
export interface GetInstrumentationConfigurationStatus extends Binding.Service<
  GetInstrumentationConfigurationStatus,
  "AWS.ApplicationSignals.GetInstrumentationConfigurationStatus",
  (
    configuration: InstrumentationConfiguration,
  ) => Effect.Effect<
    (
      request?: GetInstrumentationConfigurationStatusRequest,
    ) => Effect.Effect<
      appsignals.GetInstrumentationConfigurationStatusResponse,
      appsignals.GetInstrumentationConfigurationStatusError
    >
  >
> {}

export const GetInstrumentationConfigurationStatus =
  Binding.Service<GetInstrumentationConfigurationStatus>(
    "AWS.ApplicationSignals.GetInstrumentationConfigurationStatus",
  );
