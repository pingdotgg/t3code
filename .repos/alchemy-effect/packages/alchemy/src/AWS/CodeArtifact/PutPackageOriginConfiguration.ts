import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link PutPackageOriginConfiguration} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface PutPackageOriginConfigurationRequest extends Omit<
  codeartifact.PutPackageOriginConfigurationRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:PutPackageOriginConfiguration`.
 *
 * Sets a package's origin controls — whether new versions can be published directly and whether versions can be ingested from upstream/external sources. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.PutPackageOriginConfigurationHttp)`.
 * @binding
 * @section Managing Package Origins
 * @example Block Upstream Ingestion
 * ```typescript
 * const putOrigin = yield* AWS.CodeArtifact.PutPackageOriginConfiguration(repo);
 *
 * const res = yield* putOrigin({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   restrictions: { publish: "ALLOW", upstream: "BLOCK" },
 * });
 * console.log(res.originConfiguration?.restrictions);
 * ```
 */
export interface PutPackageOriginConfiguration extends Binding.Service<
  PutPackageOriginConfiguration,
  "AWS.CodeArtifact.PutPackageOriginConfiguration",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: PutPackageOriginConfigurationRequest,
    ) => Effect.Effect<
      codeartifact.PutPackageOriginConfigurationResult,
      codeartifact.PutPackageOriginConfigurationError
    >
  >
> {}

export const PutPackageOriginConfiguration =
  Binding.Service<PutPackageOriginConfiguration>(
    "AWS.CodeArtifact.PutPackageOriginConfiguration",
  );
