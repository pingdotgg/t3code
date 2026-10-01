import {
  AssetResource,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  AssetWorkspaceRootNormalizationError,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ExtensionOperationError,
  PreviewTabId,
  ProjectId,
  type BrowserFrameSessionTuple,
  type PreviewListResult,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  RESOURCES_LEASE_API,
  RESOURCE_LEASE_KIND_GRANTS,
  RESOURCE_LEASE_SUPPORTED_KINDS,
  type ResourceLeaseCapabilities,
  type ResourceLeaseClaimKind,
  type ResourceLeasePresentationUrl,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  ASSET_ROUTE_PREFIX,
  BrowserSurfaceIssueError,
  issueAssetUrl,
  issueBrowserSurfaceUrl,
} from "../assets/AssetAccess.ts";
import { base64UrlDecodeUtf8 } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import * as PreviewManager from "../preview/Manager.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  BrowserFrameLeases,
  browserFrameAuthorityKey,
  type BrowserFrameAuthority,
} from "../browserFrames/BrowserFrameLeases.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

type LeaseIssueResult = Effect.Success<ReturnType<typeof issueAssetUrl>>;
type LeaseIssueError = Effect.Error<ReturnType<typeof issueAssetUrl>>;

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const isOperationError = Schema.is(ExtensionOperationError);

/** Mint-time denials carry a stable name in the detail so a caller can branch on it. */
const kindDenied = (operation: string, kind: string, detail: string) =>
  failure(operation, `ResourceLeaseKindDeniedError: kind '${kind}' ${detail}`);
const grantDenied = (operation: string, kind: string, grant: string) =>
  failure(
    operation,
    `ResourceLeaseGrantDeniedError: grant '${grant}' is required to mint kind '${kind}'`,
  );
/**
 * A browser-surface ref names a live engine session: the session must exist
 * at the claimed epoch. Missing and epoch-mismatched sessions are named
 * denials — never silently re-bound.
 */
const bindingDenied = (operation: string, detail: string) =>
  failure(operation, `ResourceLeaseSessionBindingError: ${detail}`);

/**
 * Tag-preserving error mapping — the native Asset* failures surface their
 * `_tag` so an invalid/outside-root mint is named, not a generic "failed"
 * (mirrors the vcsDiffApi mapper).
 */
const operationError = (operation: string) => (cause: unknown) => {
  if (isOperationError(cause)) return cause;
  const tag =
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
      ? (cause as { _tag: string })._tag
      : cause instanceof Error
        ? cause.name
        : undefined;
  const message = cause instanceof Error ? cause.message : "Resource lease operation failed.";
  return failure(operation, `${tag ? `${tag}: ` : ""}${message}`.slice(0, 512));
};

/**
 * The browser-surface ref is not an `AssetResource` member: that union is
 * also the private `assetsCreateUrl` RPC input, and the design allows only
 * the browser sessions contract holder to mint these claims.
 */
const BrowserSurfaceRef = Schema.TaggedStruct("browser-surface", {
  threadId: ThreadId,
  tabId: PreviewTabId,
  serverEpoch: TrimmedNonEmptyString,
  allowedCommands: Schema.Array(Schema.Literals(["attach", "present", "release"])).check(
    Schema.isMinLength(1),
  ),
});

const decodeResource = Schema.decodeUnknownSync(
  Schema.Struct({ resource: Schema.Union([AssetResource, BrowserSurfaceRef]) }),
  {
    onExcessProperty: "error",
  },
);

const decodeReleasePresentationInput = Schema.decodeUnknownSync(
  Schema.Struct({ presentationUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)) }),
  {
    onExcessProperty: "error",
  },
);

/** The claim kind minted, read back out of the signed payload — the honest value. */
const KNOWN_CLAIM_KINDS = new Set<ResourceLeaseClaimKind>([
  "workspace-file",
  "workspace-file-exact",
  "project-favicon",
  "project-favicon-external",
  "browser-surface",
]);

/** Token segment of `/api/assets/<token>/browser-surface` — held-claim key. */
const surfaceTokenFromUrl = (relativeUrl: string): string | null => {
  const suffix = relativeUrl.slice("/api/assets/".length);
  const slash = suffix.indexOf("/");
  return slash === -1 ? null : suffix.slice(0, slash);
};

/** The claim token a release names — the minted URL form or the bare token. */
const surfaceTokenFromPresentation = (value: string): string | null => {
  const trimmed = value.trim();
  const prefixed = `${ASSET_ROUTE_PREFIX}/`;
  const body = trimmed.startsWith(prefixed) ? trimmed.slice(prefixed.length) : trimmed;
  const slash = body.indexOf("/");
  const token = slash === -1 ? body : body.slice(0, slash);
  return token.length > 0 ? token : null;
};

const mintedClaimKind = (relativeUrl: string): ResourceLeaseClaimKind | null => {
  try {
    const suffix = relativeUrl.slice("/api/assets/".length);
    const token = suffix.slice(0, suffix.indexOf("/"));
    const payload = token.split(".")[0];
    if (!payload) return null;
    const claims: unknown = JSON.parse(base64UrlDecodeUtf8(payload));
    if (
      claims !== null &&
      typeof claims === "object" &&
      "kind" in claims &&
      typeof claims.kind === "string" &&
      KNOWN_CLAIM_KINDS.has(claims.kind as ResourceLeaseClaimKind)
    ) {
      return claims.kind as ResourceLeaseClaimKind;
    }
  } catch {
    /* fall through to null */
  }
  return null;
};

interface ResourcesLeaseApiDependencies {
  readonly environmentId: string;
  readonly projects: {
    getById(input: {
      projectId: ProjectId;
    }): Effect.Effect<
      Option.Option<
        Pick<ProjectionProject, "projectId" | "workspaceRoot" | "faviconPath" | "deletedAt">
      >,
      ProjectionRepositoryError
    >;
  };
  readonly threads: {
    getById(input: {
      threadId: ThreadId;
    }): Effect.Effect<
      Option.Option<Pick<ProjectionThread, "projectId" | "worktreePath" | "deletedAt">>,
      ProjectionRepositoryError
    >;
  };
  readonly normalizeWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<string, WorkspacePaths.WorkspacePathsError>;
  readonly issueUrl: (input: {
    readonly resource: AssetResource;
    readonly workspaceRoot?: string;
    readonly projectFaviconPath?: string;
  }) => Effect.Effect<LeaseIssueResult, LeaseIssueError>;
  /**
   * The live engine registry, narrowed to what mint-time binding needs:
   * does `(threadId, tabId)` name a session at the manager's current epoch.
   */
  readonly preview: {
    readonly list: (input: { readonly threadId: ThreadId }) => Effect.Effect<PreviewListResult>;
  };
  readonly issueBrowserSurface: (input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly tabId: string;
    readonly serverEpoch: string;
    readonly allowedCommands: ReadonlyArray<"attach" | "present" | "release">;
  }) => Effect.Effect<
    { readonly relativeUrl: string; readonly expiresAt: number; readonly slotId: string },
    BrowserSurfaceIssueError
  >;
  /**
   * The held-claim registry the frames mint consults. `t3.browser/frames`
   * only accepts tokens recorded here — a signed claim that never passed
   * this gate cannot open a frame channel — and `releasePresentation`
   * retires the claim together with every ticket minted under its slot.
   */
  readonly leases: Pick<
    BrowserFrameLeases["Service"],
    "recordHeldSurfaceClaim" | "heldSurfaceClaim" | "revokeWhere" | "withRetainedConnection"
  >;
  /**
   * The broker's per-caller authorize check, reachable by installation id:
   * enabled + capability listed + projectIds cover the context + scope still
   * resolves. Wired by EnvironmentExtensions over the live runtime.
   */
  readonly authorizeGrant: (
    callerId: string,
    grant: string,
    context: ViewContext,
  ) => Promise<boolean>;
}

export function createResourcesLeaseApiProvider(
  dependencies: ResourcesLeaseApiDependencies,
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (principal: HostApiPrincipal | undefined) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationReadScope);

  /**
   * The held-claim authority shape — the same key the frames mint binds its
   * records to. `heldSlot` is the claim's server-owned slotId, never the
   * bearer token: two claims for one session never share a presentation slot.
   */
  const callerAuthority = (
    principal: HostApiPrincipal,
    metadata: HostApiInvocationMetadata,
    grant: string,
    context: ViewContext,
    heldSlot?: string,
  ): BrowserFrameAuthority => ({
    kind: "extension",
    principalKind: principal.kind,
    principalId: principal.id,
    ...(principal.subject !== undefined ? { subject: principal.subject } : {}),
    rootCallerId: metadata.rootCallerId,
    callerId: metadata.callerId,
    callerGenerations: metadata.callerGenerations,
    ...(metadata.rootConnectionId !== undefined
      ? { rootConnectionId: metadata.rootConnectionId }
      : {}),
    ...(heldSlot !== undefined ? { heldSlot } : {}),
    context,
    grants: [grant],
  });

  /**
   * Every caller in the chain must hold the kind's grant — the broker's
   * `requiredGrants` loop mirrored per-kind, which is why the method declares
   * none. `callerId` is always the direct caller; `callerGenerations` carries
   * the full chain when the broker populated it.
   */
  const requireKindGrant = (
    operation: string,
    kind: string,
    grant: string,
    context: ViewContext,
    metadata: HostApiInvocationMetadata,
  ): Effect.Effect<void, ExtensionOperationError> =>
    Effect.tryPromise({
      try: async () => {
        const callerIds = new Set([
          metadata.callerId,
          ...metadata.callerGenerations.map((entry) => entry.pluginId),
        ]);
        for (const callerId of callerIds) {
          if (!(await dependencies.authorizeGrant(callerId, grant, context))) return false;
        }
        return true;
      },
      // A thrown check is a host fault, not a missing grant — name it
      // differently so a plugin does not misdiagnose a transient failure.
      catch: () =>
        failure(
          operation,
          `ResourceLeaseGrantCheckError: could not evaluate grant '${grant}' for kind '${kind}'`,
        ),
    }).pipe(
      Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(grantDenied(operation, kind, grant)))),
    );

  /** Post-service re-checks — the vcsApi discipline: authority, kind grant, scope, signal. */
  const postChecks = (
    operation: string,
    context: ViewContext,
    scopeContext: ViewContext,
    metadata: HostApiInvocationMetadata,
    signal: AbortSignal,
    kindGrant?: { readonly kind: string; readonly grant: string },
  ): Effect.Effect<void, ExtensionOperationError> =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(operation, "Resource lease authority was revoked."),
      });
      if (kindGrant) {
        yield* requireKindGrant(operation, kindGrant.kind, kindGrant.grant, context, metadata);
      }
      yield* resolve(scopeContext);
      signal.throwIfAborted();
    });

  const invoke = (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ): Effect.Effect<Json, ExtensionOperationError> =>
    Effect.gen(function* () {
      signal.throwIfAborted();
      const operation = `resources.lease.${method}`;
      if (!authorized(metadata.principal) || metadata.principal === undefined) {
        return yield* failure(operation, "Resource lease authority is unavailable.");
      }
      const principal = metadata.principal;
      const scope = yield* resolve(context);
      if (method === "getCapabilities") {
        yield* postChecks(operation, context, scope.context, metadata, signal);
        return {
          supportedKinds: [...RESOURCE_LEASE_SUPPORTED_KINDS],
        } satisfies ResourceLeaseCapabilities;
      }
      if (method === "releasePresentation") {
        const safe = yield* Effect.try({
          try: () => decodeReleasePresentationInput(input),
          catch: () => failure(operation, "Invalid resource lease release input."),
        });
        // Releasing a browser-surface claim rides on the same grant as the
        // mint — a caller that lost it cannot retire claims it once held.
        const releaseGrant = RESOURCE_LEASE_KIND_GRANTS["browser-surface"];
        if (releaseGrant === undefined || releaseGrant === null) {
          return yield* kindDenied(
            operation,
            "browser-surface",
            "has no declared mint grant in this build.",
          );
        }
        yield* requireKindGrant(operation, "browser-surface", releaseGrant, context, metadata);
        const token = surfaceTokenFromPresentation(safe.presentationUrl);
        if (token === null) {
          return { released: false };
        }
        const held = yield* dependencies.leases.heldSurfaceClaim(token);
        if (Option.isNone(held)) {
          return { released: false };
        }
        // Only the claim's holder may retire it: the caller's authority must
        // equal the recorded one — the slot binding is copied from the claim
        // itself, so this reduces to the same caller, context, connection.
        const expected = callerAuthority(
          principal,
          metadata,
          releaseGrant,
          scope.context,
          held.value.authority.kind === "extension" ? held.value.authority.heldSlot : undefined,
        );
        if (
          browserFrameAuthorityKey(held.value.authority) !== browserFrameAuthorityKey(expected) ||
          !held.value.allowedCommands.includes("release")
        ) {
          return { released: false };
        }
        const claimKey = browserFrameAuthorityKey(held.value.authority);
        yield* dependencies.leases.revokeWhere(
          (record) => browserFrameAuthorityKey(record.authority) === claimKey,
        );
        return { released: true };
      }
      if (method !== "createPresentationUrl") {
        return yield* failure(operation, "Resource lease API method is unavailable.");
      }
      const safe = yield* Effect.try({
        try: () => decodeResource(input),
        catch: () => failure(operation, "Invalid resource lease request input."),
      });
      const resource = safe.resource;
      const grant =
        resource._tag in RESOURCE_LEASE_KIND_GRANTS
          ? RESOURCE_LEASE_KIND_GRANTS[resource._tag as keyof typeof RESOURCE_LEASE_KIND_GRANTS]
          : undefined;
      if (grant === undefined) {
        return yield* kindDenied(
          operation,
          resource._tag,
          "is not mintable through t3.resources/lease.",
        );
      }
      if (grant === null) {
        return yield* kindDenied(
          operation,
          resource._tag,
          "has no declared mint grant in this build.",
        );
      }
      // Grant before resolution: an unauthorized caller must not learn whether
      // a thread or project exists.
      yield* requireKindGrant(operation, resource._tag, grant, context, metadata);

      // Repository failures map to the native context-resolution error, and a
      // missing/deleted row to context-not-found — exactly the ws.ts RPC's
      // thread → project → workspaceRoot path.
      const contextResolutionError = (resolvedResource: AssetResource, cause: unknown) =>
        operationError(operation)(
          new AssetWorkspaceContextResolutionError({ resource: resolvedResource, cause }),
        );

      let issued: { readonly relativeUrl: string; readonly expiresAt: number };
      /**
       * A browser-surface claim pending held-claim registration. The mint
       * happens in the branch below, but the claim is only recorded once
       * every abortible check has passed — see the registration site after
       * `postChecks` for the lifecycle.
       */
      let browserSurface:
        | {
            readonly token: string;
            readonly slotId: string;
            readonly session: BrowserFrameSessionTuple;
            readonly allowedCommands: ReadonlyArray<string>;
            readonly expiresAt: number;
          }
        | undefined;
      if (resource._tag === "workspace-file") {
        const thread = yield* dependencies.threads
          .getById({ threadId: resource.threadId })
          .pipe(Effect.mapError((cause) => contextResolutionError(resource, cause)));
        if (Option.isNone(thread) || thread.value.deletedAt !== null) {
          return yield* operationError(operation)(
            new AssetWorkspaceContextNotFoundError({ resource }),
          );
        }
        // The resource thread must live inside the invocation's granted
        // project — the broker already proved every caller holds
        // context.projectId, so equality keeps the lease inside that wall.
        // Report it as not-found: a distinct denial would let a granted
        // caller probe thread existence in other projects.
        if (thread.value.projectId !== scope.context.resource.projectId) {
          return yield* operationError(operation)(
            new AssetWorkspaceContextNotFoundError({ resource }),
          );
        }
        const project = yield* dependencies.projects
          .getById({ projectId: thread.value.projectId })
          .pipe(Effect.mapError((cause) => contextResolutionError(resource, cause)));
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* operationError(operation)(
            new AssetWorkspaceContextNotFoundError({ resource }),
          );
        }
        issued = yield* dependencies
          .issueUrl({
            resource,
            workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
          })
          .pipe(Effect.mapError(operationError(operation)));
      } else if (resource._tag === "project-favicon") {
        const projectId = scope.context.resource.projectId;
        if (!projectId) {
          return yield* kindDenied(
            operation,
            resource._tag,
            "requires a project-scoped invocation context.",
          );
        }
        const project = yield* dependencies.projects
          .getById({ projectId: ProjectId.make(projectId) })
          .pipe(Effect.mapError((cause) => contextResolutionError(resource, cause)));
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* operationError(operation)(
            new AssetWorkspaceContextNotFoundError({ resource }),
          );
        }
        // A caller-supplied cwd that fails to normalize (does not exist, is
        // not traversable) must collapse into the same scope denial as a
        // well-formed foreign root — a distinct normalization error would be
        // a filesystem-existence oracle for arbitrary absolute paths.
        const requestedRoot = yield* Effect.option(
          dependencies.normalizeWorkspaceRoot(resource.cwd),
        );
        if (Option.isNone(requestedRoot)) {
          return yield* kindDenied(
            operation,
            resource._tag,
            "resolves outside the granted project scope.",
          );
        }
        const projectRoot = yield* dependencies
          .normalizeWorkspaceRoot(project.value.workspaceRoot)
          .pipe(
            Effect.mapError((cause) =>
              operationError(operation)(
                new AssetWorkspaceRootNormalizationError({ resource, cause }),
              ),
            ),
          );
        if (requestedRoot.value !== projectRoot) {
          return yield* kindDenied(
            operation,
            resource._tag,
            "resolves outside the granted project scope.",
          );
        }
        issued = yield* dependencies
          .issueUrl({
            resource,
            ...(project.value.faviconPath ? { projectFaviconPath: project.value.faviconPath } : {}),
          })
          .pipe(Effect.mapError(operationError(operation)));
      } else if (resource._tag === "browser-surface") {
        // Same thread → project containment wall as workspace-file, but the
        // denial collapses into the binding error: missing, deleted, and
        // cross-project threads must not be distinguishable to the caller.
        const thread = yield* dependencies.threads
          .getById({ threadId: resource.threadId })
          .pipe(Effect.mapError(operationError(operation)));
        if (
          Option.isNone(thread) ||
          thread.value.deletedAt !== null ||
          thread.value.projectId !== scope.context.resource.projectId
        ) {
          return yield* bindingDenied(
            operation,
            "the claimed thread does not resolve inside the granted scope.",
          );
        }
        const listed = yield* dependencies.preview.list({ threadId: resource.threadId });
        if (listed.serverEpoch !== resource.serverEpoch) {
          return yield* bindingDenied(
            operation,
            "the claimed engine epoch does not match the live engine epoch.",
          );
        }
        if (!listed.sessions.some((session) => session.tabId === resource.tabId)) {
          return yield* bindingDenied(
            operation,
            `session '${resource.tabId}' does not exist on the claimed thread.`,
          );
        }
        const surfaceMint = yield* dependencies
          .issueBrowserSurface({
            environmentId: dependencies.environmentId,
            threadId: resource.threadId,
            tabId: resource.tabId,
            serverEpoch: listed.serverEpoch,
            allowedCommands: resource.allowedCommands,
          })
          .pipe(Effect.mapError(operationError(operation)));
        issued = surfaceMint;
        // Held-claim registration is deferred past `postChecks`: the frames
        // mint only honors tokens recorded under this authority and tuple,
        // but a claim whose URL never reached the caller must not be left
        // held. The slot identity is the claim's server-owned slotId —
        // never the bearer token — so simultaneous mints never share a slot.
        const heldToken = surfaceTokenFromUrl(surfaceMint.relativeUrl);
        if (heldToken !== null) {
          browserSurface = {
            token: heldToken,
            slotId: surfaceMint.slotId,
            session: {
              environmentId: EnvironmentId.make(dependencies.environmentId),
              threadId: resource.threadId,
              serverEpoch: listed.serverEpoch,
              tabId: resource.tabId,
            },
            allowedCommands: resource.allowedCommands,
            expiresAt: surfaceMint.expiresAt,
          };
        }
      } else {
        // Every remaining union member (attachment today) has a declared grant
        // check above but no mint implementation in v1 — fail closed by name.
        return yield* kindDenied(
          operation,
          resource._tag,
          "has no mint implementation in this build.",
        );
      }

      const kind = mintedClaimKind(issued.relativeUrl);
      if (kind === null) {
        return yield* failure(operation, "Minted lease did not carry decodable claims.");
      }
      yield* postChecks(operation, context, scope.context, metadata, signal, {
        kind: resource._tag,
        grant,
      });

      // Held-claim registration runs only after every abortible check has
      // passed, and the onExit compensation retires the claim if
      // interruption still lands before the URL is delivered — an aborted
      // acquisition can never learn the token, so nothing else could ever
      // release it. The compensation matches the claim record by its exact
      // token, so an unrelated replacement claim is never swept with it.
      if (browserSurface !== undefined) {
        const claim = browserSurface;
        return yield* Effect.gen(function* () {
          const recorded = yield* dependencies.leases
            .recordHeldSurfaceClaim({
              token: claim.token,
              session: claim.session,
              allowedCommands: claim.allowedCommands,
              expiresAt: claim.expiresAt,
              authority: callerAuthority(principal, metadata, grant, scope.context, claim.slotId),
            })
            .pipe(Effect.mapError(operationError(operation)));
          // The root connection died between revalidation and registration —
          // the just-minted claim must not be returned as usable.
          if (!recorded) {
            return yield* bindingDenied(
              operation,
              "the minting root connection was revoked before the claim could be held.",
            );
          }
          return {
            url: issued.relativeUrl,
            expiresAt: issued.expiresAt,
            kind,
          } satisfies ResourceLeasePresentationUrl;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : dependencies.leases.revokeWhere(
                  (record) => "token" in record && record.token === claim.token,
                ),
          ),
        );
      }
      return {
        url: issued.relativeUrl,
        expiresAt: issued.expiresAt,
        kind,
      } satisfies ResourceLeasePresentationUrl;
    });

  return {
    providerId: "t3.host-resources-lease",
    definition: RESOURCES_LEASE_API,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(
        // Claim registration suspends across the abortible checks; a root
        // connection revoked in between must still have its dead-marker when
        // the registry's atomic check runs, so pin it for the invocation.
        dependencies.leases.withRetainedConnection(
          metadata.rootConnectionId,
          invoke(method, input, context, signal, metadata),
        ),
        { signal },
      ),
  };
}

export const makeResourcesLeaseApiProvider = Effect.fn("ResourcesLeaseApi.make")(function* (
  authorizeGrant: ResourcesLeaseApiDependencies["authorizeGrant"],
) {
  const environment = yield* ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const config = yield* ServerConfig.ServerConfig;
  const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const preview = yield* PreviewManager.PreviewManager;
  const issueUrl: ResourcesLeaseApiDependencies["issueUrl"] = (input) =>
    issueAssetUrl(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, faviconResolver),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  const issueBrowserSurface: ResourcesLeaseApiDependencies["issueBrowserSurface"] = (input) =>
    issueBrowserSurfaceUrl(input).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  const frameLeases = yield* BrowserFrameLeases;
  return createResourcesLeaseApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    preview,
    normalizeWorkspaceRoot: workspacePaths.normalizeWorkspaceRoot,
    issueUrl,
    issueBrowserSurface,
    leases: frameLeases,
    authorizeGrant,
  });
});
