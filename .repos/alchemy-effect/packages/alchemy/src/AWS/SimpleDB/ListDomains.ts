import type * as sdb from "@distilled.cloud/aws/simpledb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";

/**
 * Runtime binding for `sdb:ListDomains`.
 *
 * Account-level operation — invoked with no resource argument. Lists the
 * domain names in the current region, one page (up to 100 names) per call;
 * pass the response's `NextToken` back to continue. Useful for the classic
 * SimpleDB domain-sharding pattern where an application spreads items across
 * many domains and discovers them at runtime. Provide the implementation
 * with `Effect.provide(AWS.SimpleDB.ListDomainsHttp)`.
 * @binding
 * @section Domain Introspection
 * @example List Domain Names
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listDomains = yield* AWS.SimpleDB.ListDomains();
 *
 * // runtime
 * const page = yield* listDomains({ MaxNumberOfDomains: 100 });
 * // page.DomainNames: ["users-shard-0", "users-shard-1", ...]
 * ```
 */
export interface ListDomains extends Binding.Service<
  ListDomains,
  "AWS.SimpleDB.ListDomains",
  () => Effect.Effect<
    (
      request?: sdb.ListDomainsRequest,
    ) => Effect.Effect<
      sdb.ListDomainsResponse,
      sdb.ListDomainsError,
      RuntimeContext
    >
  >
> {}
export const ListDomains = Binding.Service<ListDomains>(
  "AWS.SimpleDB.ListDomains",
);
