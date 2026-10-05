import * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud Build v2 repository bindings.
 * NOT exported from index.ts.
 */
export const makeRepositoryHttpBinding = <
  I extends { repository: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E> | ((input: I) => Effect.Effect<A, E>);
}) =>
  Effect.gen(function* () {
    const run = Effect.isEffect(options.operation)
      ? yield* options.operation as GcpHttpOp<I, A, E>
      : (options.operation as (input: I) => Effect.Effect<A, E>);
    return Effect.fn(function* <T extends Repository>(repository: T) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: repository,
        iam: [grantFor(options.iam, repository.name)],
      });
      const name = yield* repository.name;
      return Effect.fn(`${options.tag}(${repository.LogicalId})`)(function* (
        request?: Omit<I, "repository">,
      ) {
        return yield* run({
          ...(request as I),
          repository: yield* name,
        } as I);
      });
    });
  });
