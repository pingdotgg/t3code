import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Domain } from "./Domain.ts";

/**
 * Shared scaffolding for SimpleDB per-operation bindings.
 *
 * INTERNAL — deliberately not exported from the service `index.ts`.
 *
 * Every SimpleDB data-plane operation follows the same shape: it targets a
 * single {@link Domain}, requires the IAM action `sdb:{Operation}` on
 * `arn:aws:sdb:{region}:{account}:domain/{domainName}`, and (except for
 * `Select`) injects the domain's physical `DomainName` into the request.
 * `makeSimpleDbBinding` encodes that once so each `{Op}Http.ts` is a thin
 * call into it; `registerSimpleDbBinding` is the deploy-time IAM half on its
 * own for operations (like `Select`) that need a custom runtime client.
 */

/**
 * Deploy-time half of a SimpleDB binding: grants `sdb:{operation}` on the
 * domain's ARN to the host Function. No-op at runtime.
 */
export const registerSimpleDbBinding = (operation: string, domain: Domain) =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host)) {
        yield* host.bind`Allow(${host}, AWS.SimpleDB.${operation}(${domain}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [`sdb:${operation}`],
              Resource: [domain.domainArn],
            },
          ],
        });
      }
    }
  });

/**
 * Builds the full binding implementation for a SimpleDB operation whose
 * request carries a `DomainName` member: registers the IAM grant and returns
 * a runtime client that closes over the domain's physical name and injects
 * it into every request.
 */
export const makeSimpleDbBinding = <
  Req extends { DomainName: string },
  A,
  E,
  R,
>(options: {
  readonly operation: string;
  readonly method: Effect.Effect<(input: Req) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const call = yield* options.method;
    return Effect.fn(function* (domain: Domain) {
      const domainName = yield* domain.domainName;
      yield* registerSimpleDbBinding(options.operation, domain);
      return Effect.fn(
        `AWS.SimpleDB.${options.operation}(${domain.LogicalId})`,
      )(function* (request?: Omit<Req, "DomainName">) {
        const name = yield* domainName;
        return yield* call({ ...request, DomainName: name } as Req);
      });
    });
  });
