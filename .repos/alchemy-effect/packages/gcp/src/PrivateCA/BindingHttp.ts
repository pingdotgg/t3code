import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

/**
 * Shared HTTP scaffolding for Certificate Authority Service bindings.
 * NOT exported from index.ts.
 */
export const makeCertificateAuthorityHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (ca: CertificateAuthority) {
      // CAs have no IAM policy of their own; access is granted on the parent pool.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${ca})`({ iam: [grantFor(options.iam, ca.caPool)] });
      }
      const name = yield* ca.name;
      return Effect.fn(`${options.tag}(${ca.LogicalId})`)(function* (request?: Omit<I, "name">) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
