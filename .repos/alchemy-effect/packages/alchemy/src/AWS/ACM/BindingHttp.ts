import type { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Shared HTTP scaffolding for the ACM runtime bindings.
 *
 * Every ACM capability follows the same shape — resolve the distilled
 * operation, register an IAM policy statement on the binding host, and return
 * a runtime callable that injects the certificate ARN. The only variation is
 * the operation, the IAM action(s), and whether the binding is scoped to one
 * certificate or to the whole account, so those are the only inputs.
 *
 * All calls are pinned to `us-east-1`, matching where the
 * {@link Certificate} resource provider requests certificates (the region
 * required for CloudFront viewer certificates).
 *
 * @internal — not exported from `index.ts`.
 */

const ACM_REGION = "us-east-1" as const;

type AcmRequirements = Credentials | AwsRegion | HttpClient.HttpClient;

const withAcmRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // `AwsRegion`'s service value is an `Effect<RegionName>` (see
  // `@distilled.cloud/aws/Region`), so it must be provided as an effect, not
  // a bare string.
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed(ACM_REGION)));

export interface AcmHttpBindingConfig<Req extends object, Out, Err> {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"DescribeCertificate"`.
   */
  capability: string;
  /**
   * IAM actions granted to the binding host, e.g. `["acm:GetCertificate"]`.
   */
  iamActions: readonly string[];
  /**
   * The distilled ACM operation implementing the capability.
   */
  operation: Effect.Effect<
    (input: Req & { CertificateArn: string }) => Effect.Effect<Out, Err>,
    never,
    AcmRequirements
  >;
}

/**
 * Build the implementation effect for a certificate-scoped ACM capability:
 * `Layer.effect(Cap, makeAcmCertificateHttpBinding({ ... }))`.
 *
 * `Req` infers as the operation's *full* distilled request (inference against
 * `Req & { CertificateArn: string }` captures the whole source type). The
 * runtime callable injects the bound certificate's ARN, so its request type
 * is `Omit<Req, "CertificateArn">` — matching the capability contracts, which
 * declare `Omit<acm.XRequest, "CertificateArn">`.
 */
export const makeAcmCertificateHttpBinding = <Req extends object, Out, Err>(
  config: AcmHttpBindingConfig<Req, Out, Err>,
) =>
  Effect.gen(function* () {
    const op = yield* withAcmRegion(config.operation);

    return Effect.fn(function* (certificate: Certificate) {
      const CertificateArn = yield* certificate.certificateArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ACM.${config.capability}(${certificate}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...config.iamActions],
                  Resource: [certificate.certificateArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.ACM.${config.capability}(${certificate.LogicalId})`,
      )(function* (request?: Omit<Req, "CertificateArn">) {
        // Sound: at instantiation `Req` always contains `CertificateArn: string`
        // (every certificate-scoped distilled request does), so
        // `Omit<Req, "CertificateArn"> & { CertificateArn: string }` is exactly
        // `Req & { CertificateArn: string }`. TypeScript cannot prove this for
        // an unresolved type parameter, hence the precise assertion.
        return yield* op({
          ...(request ?? {}),
          CertificateArn: yield* CertificateArn,
        } as Req & { CertificateArn: string });
      });
    });
  });

export interface AcmAccountHttpBindingConfig<Req extends object, Out, Err> {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListCertificates"`.
   */
  capability: string;
  /**
   * IAM actions granted to the binding host on `Resource: ["*"]` (ACM
   * account-level operations are not resource-scoped).
   */
  iamActions: readonly string[];
  /**
   * The distilled ACM operation implementing the capability.
   */
  operation: Effect.Effect<
    (input: Req) => Effect.Effect<Out, Err>,
    never,
    AcmRequirements
  >;
}

/**
 * Build the implementation effect for an account-level ACM capability (no
 * certificate argument): `Layer.effect(Cap, makeAcmAccountHttpBinding({ ... }))`.
 */
export const makeAcmAccountHttpBinding = <Req extends object, Out, Err>(
  config: AcmAccountHttpBindingConfig<Req, Out, Err>,
) =>
  Effect.gen(function* () {
    const op = yield* withAcmRegion(config.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ACM.${config.capability}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...config.iamActions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.ACM.${config.capability}`)(function* (
        request?: Req,
      ) {
        return yield* op(request ?? ({} as Req));
      });
    });
  });
