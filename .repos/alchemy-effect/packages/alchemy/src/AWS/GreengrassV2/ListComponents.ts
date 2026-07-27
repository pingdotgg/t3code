import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListComponents`.
 *
 * Enumerates the account's component definitions (latest version of each),
 * optionally scoped to `PRIVATE` or `PUBLIC` components — the entry point
 * for fleet-software inventory tooling. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.ListComponentsHttp)`.
 * @binding
 * @section Reading Components
 * @example List Private Components
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listComponents = yield* AWS.GreengrassV2.ListComponents();
 *
 * // runtime
 * const { components } = yield* listComponents({ scope: "PRIVATE" });
 * ```
 */
export interface ListComponents extends Binding.Service<
  ListComponents,
  "AWS.GreengrassV2.ListComponents",
  () => Effect.Effect<
    (
      request?: greengrassv2.ListComponentsRequest,
    ) => Effect.Effect<
      greengrassv2.ListComponentsResponse,
      greengrassv2.ListComponentsError
    >
  >
> {}
export const ListComponents = Binding.Service<ListComponents>(
  "AWS.GreengrassV2.ListComponents",
);
