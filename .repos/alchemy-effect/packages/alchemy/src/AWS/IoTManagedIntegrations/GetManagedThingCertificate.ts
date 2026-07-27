import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * Runtime binding for the `GetManagedThingCertificate` operation (IAM
 * action `iotmanagedintegrations:GetManagedThingCertificate`), scoped to
 * one {@link ManagedThing}.
 *
 * Reads the (public) certificate PEM the bound device authenticates with —
 * useful for fleet audit and certificate-rotation tooling. Provide the
 * implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingCertificateHttp)`.
 *
 * @binding
 * @section Reading Device State
 * @example Fetch the Device Certificate
 * ```typescript
 * const getCertificate =
 *   yield* IoTManagedIntegrations.GetManagedThingCertificate(thing);
 *
 * const { CertificatePem } = yield* getCertificate();
 * ```
 */
export interface GetManagedThingCertificate extends Binding.Service<
  GetManagedThingCertificate,
  "AWS.IoTManagedIntegrations.GetManagedThingCertificate",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    () => Effect.Effect<
      mi.GetManagedThingCertificateResponse,
      mi.GetManagedThingCertificateError
    >
  >
> {}
export const GetManagedThingCertificate =
  Binding.Service<GetManagedThingCertificate>(
    "AWS.IoTManagedIntegrations.GetManagedThingCertificate",
  );
