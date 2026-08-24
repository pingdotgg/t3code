import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/** Request for {@link DescribeRegistries}. */
export interface DescribeRegistriesRequest
  extends ecrpublic.DescribeRegistriesRequest {}

/**
 * Runtime binding for `ecr-public:DescribeRegistries`.
 *
 * Reads the account's public registry details — most usefully the registry
 * aliases that form public pull URIs (`public.ecr.aws/<alias>/<repo>`).
 * Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.DescribeRegistriesHttp)`.
 *
 * @binding
 * @section Registry Access
 * @example Look Up The Registry Alias
 * ```typescript
 * // init — registry-level binding takes no resource
 * const describeRegistries = yield* AWS.ECRPublic.DescribeRegistries();
 *
 * // runtime
 * const result = yield* describeRegistries();
 * const alias = result.registries?.[0]?.aliases?.[0]?.name;
 * ```
 */
export interface DescribeRegistries extends Binding.Service<
  DescribeRegistries,
  "AWS.ECRPublic.DescribeRegistries",
  () => Effect.Effect<
    (
      request?: DescribeRegistriesRequest,
    ) => Effect.Effect<
      ecrpublic.DescribeRegistriesResponse,
      ecrpublic.DescribeRegistriesError
    >
  >
> {}

export const DescribeRegistries = Binding.Service<DescribeRegistries>(
  "AWS.ECRPublic.DescribeRegistries",
);
