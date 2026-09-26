import {
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  pullRequestHostOf,
  type PullRequestRef as NativePullRequestRef,
  type RepositoryIdentity,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromRemoteUrl,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PullRequestError } from "../../pullRequest/PullRequestService.ts";
import type { PullRequestProviderApi } from "../../pullRequest/PullRequestProvider.ts";
import type { PullRequestProviderRegistry } from "../../pullRequest/PullRequestProviderRegistry.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { makeExtensionScopeResolver } from "../scope.ts";

/** The resolved invocation scope every prs adapter binds references against. */
export type PrsScope = Effect.Success<ReturnType<ReturnType<typeof makeExtensionScopeResolver>>>;

/**
 * The granted project's repository identity, resolved server-side. Every
 * reference-taking operation binds to this: plugin-supplied `host` and
 * `repository` are validated against it and never forwarded, so a
 * reference cannot make the native service route to another project's
 * credentials.
 */
export interface BoundRepository {
  readonly projectId: ProjectId;
  readonly identity: RepositoryIdentity | null;
  readonly workspaceRoot: string | null;
  /** Null when the remote's provider cannot be identified server-side. */
  readonly kind: SourceControlProviderKind | null;
  readonly host: string | null;
  readonly repository: string | null;
  readonly api: PullRequestProviderApi | null;
}

export type HostedRepository = BoundRepository & {
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly host: string;
  readonly api: PullRequestProviderApi;
};

/**
 * The project → repository-identity binding shared by the prs read and write
 * adapters. `bindRepository` resolves the granted project's own identity
 * server-side; `requireHosted` names `provider-unsupported` when no
 * registered provider serves it; `boundRef` turns a plugin ref into the
 * native hostless `PullRequestRef` or refuses it by name.
 */
export function makePrsBinding(dependencies: {
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQuery["Service"], "getProjectShellById">;
  readonly prRegistry: Pick<PullRequestProviderRegistry["Service"], "get">;
}) {
  const bindRepository = Effect.fn("PrsBinding.bindRepository")(function* (scope: PrsScope) {
    const projectId = ProjectId.make(scope.context.resource.projectId!);
    const shell = yield* dependencies.projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "resolveRepository",
            detail: "The granted project could not be read.",
            cause,
          }),
      ),
    );
    const resolved = Option.getOrNull(shell);
    const identity = resolved?.repositoryIdentity ?? null;
    if (identity === null || resolved === null) {
      return {
        projectId,
        identity,
        workspaceRoot: resolved?.workspaceRoot ?? null,
        kind: null,
        host: null,
        repository: null,
        api: null,
      } satisfies BoundRepository;
    }
    let kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === "unknown") {
      kind =
        detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)?.kind ?? "unknown";
    }
    const known = kind === undefined || kind === "unknown" ? null : kind;
    return {
      projectId,
      identity,
      workspaceRoot: resolved.workspaceRoot,
      kind: known,
      host: pullRequestHostOf(identity, kind ?? "unknown"),
      repository: sourceControlRepositorySelector(identity),
      api: known === null ? null : dependencies.prRegistry.get(known),
    } satisfies BoundRepository;
  });

  /**
   * Host-bound operations require the granted project to resolve to a
   * repository identity served by a registered provider. Anything less is
   * `provider-unsupported` by name — never an empty stand-in result.
   */
  const requireHosted = (
    bound: BoundRepository,
  ): Effect.Effect<HostedRepository, PullRequestError> =>
    bound.api === null ||
    bound.repository === null ||
    bound.host === null ||
    bound.workspaceRoot === null
      ? Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }))
      : Effect.succeed({
          ...bound,
          workspaceRoot: bound.workspaceRoot,
          repository: bound.repository,
          host: bound.host,
          api: bound.api,
        });

  /**
   * The native `PullRequestRef` a plugin ref may become: the granted
   * project's own repository selector and the requested number, with NO
   * host. Inside `requireProject` a hostless ref can only ever resolve to
   * the project itself — the cross-project host fallback is unreachable —
   * and a ref naming any other repository or host is refused before the
   * native service is invoked.
   */
  const boundRef = (
    bound: {
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly host: string;
    },
    ref: {
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    },
  ): Effect.Effect<NativePullRequestRef, PullRequestError> =>
    ref.repository.trim().toLowerCase() !== bound.repository.toLowerCase() ||
    (ref.host !== undefined && ref.host.trim().toLowerCase() !== bound.host)
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "resolveRepository",
            detail: "The change request does not belong to the granted project.",
          }),
        )
      : Effect.succeed({
          projectId: bound.projectId,
          repository: bound.repository,
          number: ref.number,
        } satisfies NativePullRequestRef);

  const bindRef = (
    scope: PrsScope,
    ref: {
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    },
  ) =>
    bindRepository(scope).pipe(
      Effect.flatMap(requireHosted),
      Effect.flatMap((hosted) => boundRef(hosted, ref)),
    );

  return { bindRepository, requireHosted, boundRef, bindRef };
}
