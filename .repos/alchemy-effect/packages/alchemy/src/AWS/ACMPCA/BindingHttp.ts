import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

/**
 * Options for {@link makeACMPCAHttpBinding}.
 *
 * @internal shared HTTP scaffolding for the ACM PCA capability bindings —
 * not exported from the service index.
 */
export interface ACMPCAHttpBindingOptions<
  Req extends { CertificateAuthorityArn: string },
  A,
  E,
  R,
> {
  /**
   * The ACM PCA action name, e.g. `"IssueCertificate"`. Used verbatim for
   * the IAM action (`acm-pca:{action}`), the bind label, and the tracing
   * span name.
   */
  action: string;
  /**
   * The distilled ACM PCA operation. Every ACM PCA data-plane operation is
   * keyed by `CertificateAuthorityArn`, which the binding injects from the
   * bound {@link CertificateAuthority}.
   */
  operation: Effect.Effect<(request: Req) => Effect.Effect<A, E>, never, R>;
}

/**
 * Build the implementation Effect for an ACM PCA HTTP capability binding.
 *
 * Every ACM PCA capability has the same shape — resolve the CA's ARN,
 * register an IAM policy statement for `acm-pca:{action}` scoped to that
 * CA at deploy time, and return a runtime callable that injects
 * `CertificateAuthorityArn` into the operation's request. Only the
 * operation and the action name differ, so each `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeACMPCAHttpBinding({ ... }))`.
 *
 * @internal
 */
export const makeACMPCAHttpBinding = <
  Req extends { CertificateAuthorityArn: string },
  A,
  E,
  R,
>(
  options: ACMPCAHttpBindingOptions<Req, A, E, R>,
) =>
  Effect.gen(function* () {
    const operation = yield* options.operation;

    return Effect.fn(function* (certificateAuthority: CertificateAuthority) {
      const Arn = yield* certificateAuthority.certificateAuthorityArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ACMPCA.${options.action}(${certificateAuthority}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [`acm-pca:${options.action}`],
                  Resource: [certificateAuthority.certificateAuthorityArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.ACMPCA.${options.action}(${certificateAuthority.LogicalId})`,
      )(function* (
        request: Omit<Req, "CertificateAuthorityArn"> = {} as Omit<
          Req,
          "CertificateAuthorityArn"
        >,
      ) {
        return yield* operation({
          ...request,
          CertificateAuthorityArn: yield* Arn,
        } as Req);
      });
    });
  });
