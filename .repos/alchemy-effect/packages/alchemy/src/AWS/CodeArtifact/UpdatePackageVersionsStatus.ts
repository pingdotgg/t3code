import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link UpdatePackageVersionsStatus} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface UpdatePackageVersionsStatusRequest extends Omit<
  codeartifact.UpdatePackageVersionsStatusRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:UpdatePackageVersionsStatus`.
 *
 * Transitions package versions between statuses (e.g. `Unfinished` → `Published`, or `Published` → `Archived` to hide them from installs). Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.UpdatePackageVersionsStatusHttp)`.
 * @binding
 * @section Managing Version Status
 * @example Publish an Unfinished Version
 * ```typescript
 * const updateStatus = yield* AWS.CodeArtifact.UpdatePackageVersionsStatus(repo);
 *
 * const res = yield* updateStatus({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   versions: ["1.0.0"],
 *   targetStatus: "Published",
 * });
 * console.log(res.successfulVersions);
 * ```
 */
export interface UpdatePackageVersionsStatus extends Binding.Service<
  UpdatePackageVersionsStatus,
  "AWS.CodeArtifact.UpdatePackageVersionsStatus",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: UpdatePackageVersionsStatusRequest,
    ) => Effect.Effect<
      codeartifact.UpdatePackageVersionsStatusResult,
      codeartifact.UpdatePackageVersionsStatusError
    >
  >
> {}

export const UpdatePackageVersionsStatus =
  Binding.Service<UpdatePackageVersionsStatus>(
    "AWS.CodeArtifact.UpdatePackageVersionsStatus",
  );
