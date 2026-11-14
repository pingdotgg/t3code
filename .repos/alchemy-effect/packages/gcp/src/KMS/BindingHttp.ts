import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { CryptoKey } from "./CryptoKey.ts";

/**
 * Shared HTTP scaffolding for Cloud KMS CryptoKey bindings.
 * NOT exported from index.ts.
 */
export const makeCryptoKeyHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (key: CryptoKey) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${key})`({ iam: [grantFor(options.iam, key.name)] });
      }
      const name = yield* key.name;
      return Effect.fn(`${options.tag}(${key.LogicalId})`)(function* (request?: Omit<I, "name">) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
