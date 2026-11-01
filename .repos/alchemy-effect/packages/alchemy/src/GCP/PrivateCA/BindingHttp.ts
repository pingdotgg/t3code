import * as Effect from "effect/Effect";
import type { CertificateAuthority } from "./CertificateAuthority.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Certificate Authority Service bindings.
 * NOT exported from index.ts.
 */
export const makeCertificateAuthorityHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (ca: CertificateAuthority) {
      // CAs have no IAM policy of their own; access is granted on the parent pool.
      yield* bindGcpHost({
        tag: options.tag,
        resource: ca,
        iam: [grantFor(options.iam, ca.caPool)],
      });
      const name = yield* ca.name;
      return Effect.fn(`${options.tag}(${ca.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
