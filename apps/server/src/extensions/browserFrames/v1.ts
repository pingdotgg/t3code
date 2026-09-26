/**
 * `t3.browser/frames@1.0.0` — remote pixel transport capability.
 *
 * This adapter mints lease-bound tickets only; frames and input packets move
 * over `/api/browser-frames/*` (BrowserFrameProxy), never through the invoke
 * channel. Session existence is checked against PreviewManager; the owning
 * engine host is resolved through the broker's advertised frame hubs. Actions
 * stay on `t3.browser/sessions` — nothing here dispatches browser commands.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ExtensionOperationError,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  browserFramesApi,
  type BrowserFrameInputLease,
  type BrowserFramesCapabilities,
  type BrowserFrameStreamDescriptor,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import {
  canonicalizeFrameHubOrigin,
  PreviewAutomationBroker,
} from "../../mcp/PreviewAutomationBroker.ts";
import {
  BrowserFrameLeases,
  browserFrameAuthorityKey,
  type BrowserFrameAuthority,
} from "../../browserFrames/BrowserFrameLeases.ts";
import { BROWSER_FRAMES_ROUTE_PREFIX } from "@t3tools/contracts";
import { ASSET_ROUTE_PREFIX, verifyBrowserSurfaceClaims } from "../../assets/AssetAccess.ts";
import { base64UrlDecodeUtf8 } from "../../auth/utils.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { makeExtensionScopeResolver } from "../scope.ts";

const OPERATION = "browser.frames";
const INPUT_PATHS = { input: "input" } as const;

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const named = (operation: string, name: string, detail: string) =>
  failure(operation, `${name}: ${detail}`);
const isOperationError = Schema.is(ExtensionOperationError);
const operationError = (operation: string) => (cause: unknown) => {
  if (isOperationError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : "Browser frames operation failed.";
  return failure(operation, message.slice(0, 512));
};

const EmptyInput = Schema.Record(Schema.String, Schema.Never);
const decodeReadInput = Schema.decodeUnknownEffect(EmptyInput, { onExcessProperty: "error" });
const decodeTargetInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    tabId: PreviewTabId,
    serverEpoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    surfaceLease: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
    expectedEngineGeneration: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
    ),
  }),
  { onExcessProperty: "error" },
);
const decodeInputTargetInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    tabId: PreviewTabId,
    serverEpoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    surfaceLease: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
    expectedEngineGeneration: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
    ),
    /** Present on renewal: must name a live lease owned by this authority+tuple. */
    leaseId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  }),
  { onExcessProperty: "error" },
);
const decodeLeaseInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    leaseId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    /**
     * The closing caller's own presentation claim. Lease records are keyed to
     * the slot that minted them — without it the close cannot name its slot
     * and closes nothing.
     */
    surfaceLease: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  }),
  { onExcessProperty: "error" },
);

/**
 * The client presents the value `resourcesLease.createPresentationUrl`
 * returned (`/api/assets/<token>/browser-surface`) or the bare signed token.
 * `verifyBrowserSurfaceClaims` enforces signature+tuple either way; this only
 * extracts the token segment.
 */
const surfaceTokenFromLease = (value: string): string => {
  const trimmed = value.trim();
  const prefixed = `${ASSET_ROUTE_PREFIX}/`;
  const body = trimmed.startsWith(prefixed) ? trimmed.slice(prefixed.length) : trimmed;
  const slash = body.indexOf("/");
  return slash === -1 ? body : body.slice(0, slash);
};

/**
 * The slot identity a presented claim carries — read from the unsigned
 * payload copy (the held-claim check compares authority keys; a forged
 * payload can only name a slot it cannot own). No `slotId` decodable names
 * no slot, so a malformed claim closes nothing.
 */
const surfaceSlotIdFromLease = (value: string): string | undefined => {
  const payload = surfaceTokenFromLease(value).split(".")[0];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(base64UrlDecodeUtf8(payload));
    if (
      claims !== null &&
      typeof claims === "object" &&
      "slotId" in claims &&
      typeof claims.slotId === "string" &&
      claims.slotId.length > 0
    ) {
      return claims.slotId;
    }
  } catch {
    /* fall through to undefined */
  }
  return undefined;
};

const sessionPath = (tabId: string, leaf: string) =>
  `${BROWSER_FRAMES_ROUTE_PREFIX}/sessions/${encodeURIComponent(tabId)}/${leaf}`;

export function createBrowserFramesApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly preview: Pick<PreviewManager.PreviewManager["Service"], "listDetails">;
    readonly leases: BrowserFrameLeases["Service"];
    readonly broker: Pick<PreviewAutomationBroker["Service"], "frameHubs">;
    /**
     * Verify a held `browser-surface` claim against the minted tuple. Services
     * are provided by the factory — the provider body runs without a layer.
     */
    readonly verifySurfaceClaims: (
      token: string,
      expected: {
        readonly environmentId: string;
        readonly threadId: string;
        readonly tabId: string;
        readonly serverEpoch: string;
      },
    ) => Effect.Effect<{ readonly expiresAt: number; readonly slotId: string } | null>;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);

  const authorized = (principal: HostApiPrincipal | undefined, write: boolean) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationReadScope) &&
    (!write || principal.scopes.includes(AuthOrchestrationOperateScope));

  const invoke = (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ): Effect.Effect<Json, ExtensionOperationError> =>
    Effect.gen(function* () {
      signal.throwIfAborted();
      const operation = `${OPERATION}.${method}`;
      const principal = metadata.principal;
      const write = method === "openInput" || method === "closeInput";
      if (!authorized(principal, write) || !metadata.assertAuthority || principal === undefined) {
        return yield* failure(operation, "Browser frames authority is unavailable.");
      }
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(operation, "Browser frames authority was revoked."),
      });
      const scope = yield* resolve(context);
      const threadIdRaw = scope.context.resource.threadId;
      if (!threadIdRaw) {
        return yield* failure(operation, "Browser frames require a thread-scoped context.");
      }
      const threadId = ThreadId.make(threadIdRaw);

      if (method === "getCapabilities") {
        yield* decodeReadInput(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserFramesInputError",
              "getCapabilities input fails the declared schema.",
            ),
          ),
        );
        // Same resolution the mint applies: only a canonical, reachable,
        // unambiguous engine host counts — zero or ambiguous hubs report
        // unsupported rather than promising a mint that will be refused.
        const hubs = (yield* dependencies.broker.frameHubs.pipe(
          Effect.mapError(operationError(operation)),
        )).filter(
          (hub) =>
            hub.environmentId === dependencies.environmentId &&
            canonicalizeFrameHubOrigin(hub.origin) === hub.origin,
        );
        const unambiguous = hubs.length === 1;
        return {
          metadata: { supported: true },
          stream: unambiguous
            ? { supported: true }
            : { supported: false, reason: "engine-unavailable" },
          input: { supported: unambiguous },
        } satisfies BrowserFramesCapabilities;
      }

      /**
       * The verified authority a mint binds to: the root principal (for
       * `environment-session` roots, `principalId` is the session id), the
       * caller chain and its installation generations, the resolved view
       * context, the grants the broker already enforced for this method, the
       * root connection identity, and — once the presented claim is
       * verified — the held presentation slot's server-owned slotId. Two
       * slots sharing everything else still get distinct authority keys, so
       * one cannot renew or close the other's lease.
       */
      const authorityFor = (heldSlot?: string): BrowserFrameAuthority => ({
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
        context: scope.context,
        grants:
          browserFramesApi.definition.methods?.find((entry) => entry.name === method)
            ?.requiredGrants ?? [],
      });

      const requireSession = Effect.fn("BrowserFrames.requireSession")(function* (target: {
        readonly tabId: string;
        readonly serverEpoch: string;
        readonly surfaceLease: string;
      }) {
        const listed = yield* dependencies.preview
          .listDetails({ threadId })
          .pipe(Effect.mapError(operationError(operation)));
        if (target.serverEpoch !== listed.serverEpoch) {
          return yield* named(
            operation,
            "BrowserStaleServerEpoch",
            "the request epoch does not match the live session epoch.",
          );
        }
        const detail = listed.sessions.find((entry) => entry.snapshot.tabId === target.tabId);
        if (!detail) {
          return yield* named(
            operation,
            "BrowserSessionNotFound",
            "no live browser session matches tabId.",
          );
        }
        // The mint requires a held presentation claim for exactly this session
        // tuple — watching without presentation authority is not enough. The
        // claim's server-owned slotId is this slot's identity inside the mint
        // authority — the bearer token never stands in for it.
        const surfaceToken = surfaceTokenFromLease(target.surfaceLease);
        const claims = yield* dependencies
          .verifySurfaceClaims(surfaceToken, {
            environmentId: dependencies.environmentId,
            threadId,
            tabId: target.tabId,
            serverEpoch: target.serverEpoch,
          })
          .pipe(Effect.mapError(operationError(operation)));
        if (claims === null) {
          return yield* named(
            operation,
            "BrowserSurfaceClaimDenied",
            "no live browser-surface presentation lease covers this session.",
          );
        }
        const authority = authorityFor(claims.slotId);
        // A valid signature is not mint authority: the claim must have been
        // acquired through `t3.resources/lease` by this same authority for
        // this same tuple — an unheld or foreign-held token is denied.
        const held = yield* dependencies.leases.heldSurfaceClaim(surfaceToken);
        if (
          Option.isNone(held) ||
          browserFrameAuthorityKey(held.value.authority) !== browserFrameAuthorityKey(authority) ||
          held.value.session.environmentId !== dependencies.environmentId ||
          held.value.session.threadId !== threadId ||
          held.value.session.serverEpoch !== target.serverEpoch ||
          held.value.session.tabId !== target.tabId ||
          !held.value.allowedCommands.includes("present")
        ) {
          return yield* named(
            operation,
            "BrowserSurfaceClaimDenied",
            "the presented browser-surface claim is not held by this authority for this session.",
          );
        }
        const hubs = (yield* dependencies.broker.frameHubs.pipe(
          Effect.mapError(operationError(operation)),
        )).filter(
          (hub) =>
            hub.environmentId === dependencies.environmentId &&
            canonicalizeFrameHubOrigin(hub.origin) === hub.origin,
        );
        if (hubs.length === 0) {
          return yield* named(
            operation,
            "BrowserEngineUnavailable",
            "no connected engine host serves browser frames.",
          );
        }
        if (hubs.length > 1) {
          return yield* named(
            operation,
            "BrowserEngineAmbiguous",
            "more than one engine host serves this environment; refusing to bind.",
          );
        }
        const host = hubs[0]!;
        return {
          hostClientId: host.clientId,
          hostConnectionId: host.connectionId,
          claimExpiresAt: claims.expiresAt,
          authority,
        };
      });

      if (method === "openStream") {
        const target = yield* decodeTargetInput(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserFramesInputError",
              "openStream input fails the declared schema.",
            ),
          ),
        );
        const { hostClientId, hostConnectionId, claimExpiresAt, authority } =
          yield* requireSession(target);
        const issued = yield* dependencies.leases.issueStreamTicket({
          authority,
          authorityExpiresAt: claimExpiresAt,
          session: {
            environmentId: EnvironmentId.make(dependencies.environmentId),
            threadId,
            serverEpoch: target.serverEpoch,
            tabId: target.tabId,
          },
          engineGeneration: target.expectedEngineGeneration ?? null,
          hostClientId,
          hostConnectionId,
        });
        if (Option.isNone(issued)) {
          return yield* named(
            operation,
            "BrowserStreamTicketDenied",
            "the presentation claim was released or the mint authority's root connection is no longer live.",
          );
        }
        return {
          session: {
            environmentId: dependencies.environmentId,
            threadId,
            serverEpoch: target.serverEpoch,
            tabId: target.tabId,
            engineGeneration: target.expectedEngineGeneration ?? null,
          },
          hostId: hostClientId,
          paths: {
            stream: sessionPath(target.tabId, "stream.mjpeg"),
            snapshot: sessionPath(target.tabId, "snapshot"),
            config: sessionPath(target.tabId, "config"),
          },
          ticket: issued.value.ticket,
          expiresAt: issued.value.expiresAt,
        } satisfies BrowserFrameStreamDescriptor;
      }

      if (method === "openInput") {
        const target = yield* decodeInputTargetInput(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserFramesInputError",
              "openInput input fails the declared schema.",
            ),
          ),
        );
        const { hostClientId, hostConnectionId, claimExpiresAt, authority } =
          yield* requireSession(target);
        const issued = yield* dependencies.leases.issueInputLease({
          authority,
          authorityExpiresAt: claimExpiresAt,
          session: {
            environmentId: EnvironmentId.make(dependencies.environmentId),
            threadId,
            serverEpoch: target.serverEpoch,
            tabId: target.tabId,
          },
          engineGeneration: target.expectedEngineGeneration ?? null,
          hostClientId,
          hostConnectionId,
          ...(target.leaseId !== undefined ? { leaseId: target.leaseId } : {}),
        });
        if (Option.isNone(issued)) {
          return yield* named(
            operation,
            "BrowserInputLeaseDenied",
            "the named lease is not a live lease owned by this caller for this session, the presentation claim was released, or the root connection is no longer live.",
          );
        }
        return {
          leaseId: issued.value.leaseId,
          inputTicket: issued.value.inputTicket,
          expiresAt: issued.value.expiresAt,
          paths: { input: sessionPath(target.tabId, INPUT_PATHS.input) },
        } satisfies BrowserFrameInputLease;
      }

      if (method === "closeInput") {
        const decoded = yield* decodeLeaseInput(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserFramesInputError",
              "closeInput input fails the declared schema.",
            ),
          ),
        );
        // Slot-keyed ownership: the close only lands when the presented
        // presentation claim names the same slot that minted the lease.
        const authority = authorityFor(
          decoded.surfaceLease !== undefined
            ? surfaceSlotIdFromLease(decoded.surfaceLease)
            : undefined,
        );
        const lease = yield* dependencies.leases.resolveLease(decoded.leaseId);
        if (
          Option.isSome(lease) &&
          browserFrameAuthorityKey(lease.value.authority) === browserFrameAuthorityKey(authority) &&
          lease.value.session.environmentId === dependencies.environmentId &&
          lease.value.session.threadId === threadId
        ) {
          yield* dependencies.leases.revokeLease(decoded.leaseId);
          return { closed: true };
        }
        return { closed: false };
      }

      return yield* named(operation, "BrowserFramesUnknownMethod", `unknown method '${method}'.`);
    }).pipe(Effect.mapError(operationError(`${OPERATION}.${method}`)));

  return {
    providerId: "t3.host-browser-frames",
    definition: browserFramesApi.definition,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(
        // The claim read and the registry mint suspend across async work; a
        // root-connection revocation landing in between must still find its
        // dead-marker fence when the mint resumes, so the connection's marker
        // is pinned for the whole invocation.
        dependencies.leases.withRetainedConnection(
          metadata.rootConnectionId,
          invoke(method, input, context, signal, metadata),
        ),
        { signal },
      ),
  };
}

export const makeBrowserFramesApiProvider = Effect.fn("BrowserFramesApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return createBrowserFramesApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    preview: yield* PreviewManager.PreviewManager,
    leases: yield* BrowserFrameLeases,
    broker: yield* PreviewAutomationBroker,
    verifySurfaceClaims: (token, expected) =>
      verifyBrowserSurfaceClaims(token, expected).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      ),
  });
});
