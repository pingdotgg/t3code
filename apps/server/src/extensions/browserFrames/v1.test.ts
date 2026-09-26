import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import { BROWSER_FRAMES, BROWSER_SESSIONS } from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  BrowserFrameLeases,
  layer as BrowserFrameLeasesLayer,
  type BrowserFrameAuthority,
} from "../../browserFrames/BrowserFrameLeases.ts";
import { createBrowserFramesApiProvider } from "./v1.ts";
import { createResourcesLeaseApiProvider } from "../resourcesLeaseApi.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const signal = new AbortController().signal;
const ENV_ID = "env";
const PROJECT_ID = "project";
const THREAD_ID = "thread";
const WORKSPACE = "/repo/workspace";
const CLAIM_EXPIRES = 4_102_444_800_000;

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{
  readonly cause: unknown;
}> {}

const context = (): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "view",
    environmentId: ENV_ID,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(WORKSPACE, null),
});

const meta = (
  provider: HostApiProvider,
  options: { readonly callerId?: string; readonly rootConnectionId?: string } = {},
): HostApiInvocationMetadata => ({
  callId: "call",
  rootCallerId: "root",
  callerId: options.callerId ?? "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  ...(options.rootConnectionId !== undefined ? { rootConnectionId: options.rootConnectionId } : {}),
  principal: {
    kind: "environment-session" as const,
    id: "session",
    environmentId: ENV_ID,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  },
  assertAuthority: async () => {},
});

/** The authority the provider builds from `meta` + the resolved context. */
const providerAuthority = (
  options: {
    readonly callerId?: string;
    readonly heldSlot?: string;
    readonly rootConnectionId?: string;
  } = {},
): BrowserFrameAuthority => ({
  kind: "extension",
  principalKind: "environment-session",
  principalId: "session",
  rootCallerId: "root",
  callerId: options.callerId ?? "caller",
  callerGenerations: [],
  ...(options.heldSlot !== undefined ? { heldSlot: options.heldSlot } : {}),
  ...(options.rootConnectionId !== undefined ? { rootConnectionId: options.rootConnectionId } : {}),
  // `resolve` normalizes in place — with projectId/workspaceRevision already
  // correct, this object is the resolved scope context verbatim.
  context: context(),
  grants: [BROWSER_SESSIONS, BROWSER_FRAMES],
});

const makeDeps = (
  leases: BrowserFrameLeases["Service"],
  overrides: {
    readonly hubs?: ReadonlyArray<{
      readonly clientId: string;
      readonly connectionId: string;
      readonly environmentId: string;
      readonly origin: string;
      readonly secret: string;
    }>;
    readonly verifySurfaceClaims?: (
      token: string,
      expected: {
        readonly environmentId: string;
        readonly threadId: string;
        readonly tabId: string;
        readonly serverEpoch: string;
      },
    ) => Effect.Effect<{ readonly expiresAt: number; readonly slotId: string } | null>;
  } = {},
): Parameters<typeof createBrowserFramesApiProvider>[0] => ({
  environmentId: ENV_ID,
  projects: {
    getById: () =>
      Effect.succeedSome({
        projectId: ProjectId.make(PROJECT_ID),
        workspaceRoot: WORKSPACE,
        deletedAt: null,
      }),
  },
  threads: {
    getById: () =>
      Effect.succeedSome({
        projectId: ProjectId.make(PROJECT_ID),
        worktreePath: null,
        deletedAt: null,
      }),
  },
  preview: {
    listDetails: () =>
      Effect.succeed({
        serverEpoch: "epoch-1",
        sessions: [{ snapshot: { tabId: "tab-1" } }],
      }),
  } as never,
  leases,
  broker: {
    frameHubs: Effect.succeed(
      overrides.hubs ?? [
        {
          clientId: "h",
          connectionId: "hc",
          environmentId: ENV_ID,
          origin: "http://127.0.0.1:49152",
          secret: "s",
        },
      ],
    ),
  } as never,
  // The claim's slot identity lives in its signed payload — the fake verifier
  // decodes it like the real one so tests exercise slotId ≠ token.
  verifySurfaceClaims:
    overrides.verifySurfaceClaims ??
    ((token) => {
      try {
        const claims: unknown = JSON.parse(
          Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
        );
        if (
          claims !== null &&
          typeof claims === "object" &&
          "slotId" in claims &&
          typeof claims.slotId === "string"
        ) {
          return Effect.succeed({ expiresAt: CLAIM_EXPIRES, slotId: claims.slotId });
        }
      } catch {
        /* fall through to null */
      }
      return Effect.succeed(null);
    }),
});

/** A claim-shaped test token whose payload binds `slotId`, like a real mint. */
const surfaceToken = (slotId: string) =>
  `${Buffer.from(JSON.stringify({ kind: "browser-surface", slotId })).toString("base64url")}.sig`;

const LeasesLive = BrowserFrameLeasesLayer.pipe(Layer.provideMerge(NodeServices.layer));

const harness = Effect.gen(function* () {
  const leases = yield* BrowserFrameLeases;
  return { leases };
}).pipe(Effect.provide(LeasesLive));

const invoke = (
  provider: HostApiProvider,
  method: string,
  input: unknown,
  metadata?: HostApiInvocationMetadata,
) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(
        provider.invoke(method, input as never, context(), signal, metadata ?? meta(provider)),
      ),
    catch: (cause) => new InvokeRejection({ cause }),
  });

const invokeError = (...args: Parameters<typeof invoke>) =>
  invoke(...args).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) throw rejection.cause;
      return rejection.cause;
    }),
  );

const openStreamInput = (surfaceLease = surfaceToken("slot-1")) => ({
  tabId: "tab-1",
  serverEpoch: "epoch-1",
  surfaceLease,
});

const recordClaim = (
  leases: BrowserFrameLeases["Service"],
  token: string,
  authority: BrowserFrameAuthority,
  allowedCommands: ReadonlyArray<string> = ["attach", "present", "release"],
) =>
  leases.recordHeldSurfaceClaim({
    token,
    authority,
    session: {
      environmentId: "env" as never,
      threadId: "thread" as never,
      serverEpoch: "epoch-1",
      tabId: "tab-1" as never,
    },
    allowedCommands,
    expiresAt: CLAIM_EXPIRES,
  });

/** Minimal resources-lease deps — enough to drive `releasePresentation`. */
const resourcesDeps = (
  leases: BrowserFrameLeases["Service"],
): Parameters<typeof createResourcesLeaseApiProvider>[0] => ({
  environmentId: ENV_ID,
  projects: {
    getById: () =>
      Effect.succeedSome({
        projectId: ProjectId.make(PROJECT_ID),
        workspaceRoot: WORKSPACE,
        faviconPath: null,
        deletedAt: null,
      }),
  },
  threads: {
    getById: () =>
      Effect.succeedSome({
        projectId: ProjectId.make(PROJECT_ID),
        worktreePath: null,
        deletedAt: null,
      }),
  },
  normalizeWorkspaceRoot: (root) => Effect.succeed(root),
  preview: { list: () => Effect.die("unused in this test") },
  issueUrl: () => Effect.die("unused in this test"),
  issueBrowserSurface: () => Effect.die("unused in this test"),
  leases,
  authorizeGrant: async () => true,
});

describe("browser frames adapter", () => {
  it.effect("openStream denies a signed token that was never held", () =>
    Effect.gen(function* () {
      const { leases } = yield* harness;
      const provider = createBrowserFramesApiProvider(makeDeps(leases));
      const error = yield* invokeError(provider, "openStream", openStreamInput(), meta(provider));
      expect(error.detail).toContain("BrowserSurfaceClaimDenied");
    }),
  );

  it.effect("openStream denies a claim held by a different caller authority", () =>
    Effect.gen(function* () {
      const { leases } = yield* harness;
      const provider = createBrowserFramesApiProvider(makeDeps(leases));
      yield* recordClaim(
        leases,
        surfaceToken("slot-1"),
        providerAuthority({ callerId: "other-caller", heldSlot: "slot-1" }),
      );
      const error = yield* invokeError(provider, "openStream", openStreamInput(), meta(provider));
      expect(error.detail).toContain("BrowserSurfaceClaimDenied");
    }),
  );

  it.effect(
    "openStream mints a ticket bound to the sole canonical hub once the claim is held",
    () =>
      Effect.gen(function* () {
        const { leases } = yield* harness;
        const provider = createBrowserFramesApiProvider(makeDeps(leases));
        yield* recordClaim(
          leases,
          surfaceToken("slot-1"),
          providerAuthority({ heldSlot: "slot-1" }),
        );
        const result = (yield* invoke(
          provider,
          "openStream",
          openStreamInput(),
          meta(provider),
        )) as {
          readonly ticket: string;
          readonly hostId: string;
          readonly expiresAt: number;
          readonly paths: { readonly stream: string };
        };
        expect(result.hostId).toBe("h");
        expect(result.ticket.startsWith("bfv1.st.")).toBe(true);
        // The minted credential never outlives the held claim.
        expect(result.expiresAt).toBeLessThanOrEqual(CLAIM_EXPIRES);
        expect(Option.isSome(yield* leases.verify(result.ticket))).toBe(true);
      }),
  );

  it.effect("openStream denies a held claim that lacks the present command", () =>
    Effect.gen(function* () {
      const { leases } = yield* harness;
      const provider = createBrowserFramesApiProvider(makeDeps(leases));
      yield* recordClaim(
        leases,
        surfaceToken("slot-1"),
        providerAuthority({ heldSlot: "slot-1" }),
        ["attach"],
      );
      const error = yield* invokeError(provider, "openStream", openStreamInput(), meta(provider));
      expect(error.detail).toContain("BrowserSurfaceClaimDenied");
    }),
  );

  it.effect("capabilities stay honest when the engine host is ambiguous or unreachable", () =>
    Effect.gen(function* () {
      const { leases } = yield* harness;
      const ambiguous = createBrowserFramesApiProvider(
        makeDeps(leases, {
          hubs: [
            {
              clientId: "h1",
              connectionId: "c1",
              environmentId: ENV_ID,
              origin: "http://127.0.0.1:1",
              secret: "s",
            },
            {
              clientId: "h2",
              connectionId: "c2",
              environmentId: ENV_ID,
              origin: "http://127.0.0.1:2",
              secret: "s",
            },
          ],
        }),
      );
      const capabilities = (yield* invoke(ambiguous, "getCapabilities", {})) as {
        readonly stream: { readonly supported: boolean; readonly reason?: string };
        readonly input: { readonly supported: boolean };
      };
      expect(capabilities.stream).toEqual({ supported: false, reason: "engine-unavailable" });
      expect(capabilities.input.supported).toBe(false);

      // A non-canonical advertised origin never counts toward capability.
      const unreachable = createBrowserFramesApiProvider(
        makeDeps(leases, {
          hubs: [
            {
              clientId: "h",
              connectionId: "hc",
              environmentId: ENV_ID,
              origin: "http://127.0.0.1:1/private",
              secret: "s",
            },
          ],
        }),
      );
      const filtered = (yield* invoke(unreachable, "getCapabilities", {})) as {
        readonly stream: { readonly supported: boolean };
        readonly input: { readonly supported: boolean };
      };
      expect(filtered.stream.supported).toBe(false);
      expect(filtered.input.supported).toBe(false);
    }),
  );

  it.effect(
    "distinct held presentation slots mint isolated input leases in an identical context",
    () =>
      Effect.gen(function* () {
        const { leases } = yield* harness;
        const provider = createBrowserFramesApiProvider(makeDeps(leases));
        for (const slotId of ["slot-a", "slot-b"]) {
          yield* recordClaim(leases, surfaceToken(slotId), providerAuthority({ heldSlot: slotId }));
        }
        const a = (yield* invoke(
          provider,
          "openInput",
          openStreamInput(surfaceToken("slot-a")),
        )) as {
          readonly leaseId: string;
          readonly inputTicket: string;
        };
        const b = (yield* invoke(
          provider,
          "openInput",
          openStreamInput(surfaceToken("slot-b")),
        )) as {
          readonly leaseId: string;
          readonly inputTicket: string;
        };
        // Two slots under one caller chain and view context never share a lease.
        expect(a.leaseId).not.toBe(b.leaseId);
        // The second slot's mint does not supersede the first slot's ticket.
        expect(Option.isSome(yield* leases.verify(a.inputTicket))).toBe(true);
        expect(Option.isSome(yield* leases.verify(b.inputTicket))).toBe(true);

        // A close that names no slot — or another slot's claim — closes nothing.
        const unnamed = (yield* invoke(provider, "closeInput", { leaseId: b.leaseId })) as {
          readonly closed: boolean;
        };
        expect(unnamed).toEqual({ closed: false });
        const foreign = (yield* invoke(provider, "closeInput", {
          leaseId: b.leaseId,
          surfaceLease: surfaceToken("slot-a"),
        })) as { readonly closed: boolean };
        expect(foreign).toEqual({ closed: false });
        expect(Option.isSome(yield* leases.verify(b.inputTicket))).toBe(true);

        // Cross-slot renewal is refused; same-slot renewal bumps ticketSeq.
        const stolen = yield* invokeError(provider, "openInput", {
          ...openStreamInput(surfaceToken("slot-b")),
          leaseId: a.leaseId,
        });
        expect(stolen.detail).toContain("BrowserInputLeaseDenied");
        const renewed = (yield* invoke(provider, "openInput", {
          ...openStreamInput(surfaceToken("slot-a")),
          leaseId: a.leaseId,
        })) as { readonly leaseId: string; readonly inputTicket: string };
        expect(renewed.leaseId).toBe(a.leaseId);
        expect(Option.isNone(yield* leases.verify(a.inputTicket))).toBe(true);
        expect(Option.isSome(yield* leases.verify(renewed.inputTicket))).toBe(true);

        // The slot that minted a lease is the only authority that closes it.
        const closed = (yield* invoke(provider, "closeInput", {
          leaseId: b.leaseId,
          surfaceLease: surfaceToken("slot-b"),
        })) as { readonly closed: boolean };
        expect(closed).toEqual({ closed: true });
        expect(Option.isNone(yield* leases.verify(b.inputTicket))).toBe(true);
        expect(Option.isSome(yield* leases.verify(renewed.inputTicket))).toBe(true);
      }),
  );

  it.effect("root connection identity separates identical-context mints sharing a session", () =>
    Effect.gen(function* () {
      const { leases } = yield* harness;
      const provider = createBrowserFramesApiProvider(makeDeps(leases));
      yield* recordClaim(
        leases,
        surfaceToken("slot-a"),
        providerAuthority({ heldSlot: "slot-a", rootConnectionId: "conn-1" }),
      );
      yield* recordClaim(
        leases,
        surfaceToken("slot-b"),
        providerAuthority({ heldSlot: "slot-b", rootConnectionId: "conn-2" }),
      );
      const first = (yield* invoke(
        provider,
        "openInput",
        openStreamInput(surfaceToken("slot-a")),
        meta(provider, { rootConnectionId: "conn-1" }),
      )) as { readonly leaseId: string; readonly inputTicket: string };
      const second = (yield* invoke(
        provider,
        "openInput",
        openStreamInput(surfaceToken("slot-b")),
        meta(provider, { rootConnectionId: "conn-2" }),
      )) as { readonly leaseId: string; readonly inputTicket: string };
      expect(first.leaseId).not.toBe(second.leaseId);
      expect(Option.isSome(yield* leases.verify(first.inputTicket))).toBe(true);
      expect(Option.isSome(yield* leases.verify(second.inputTicket))).toBe(true);
      // A claim recorded under one connection does not satisfy another's mint.
      const denied = yield* invokeError(
        provider,
        "openInput",
        openStreamInput(surfaceToken("slot-a")),
        meta(provider, { rootConnectionId: "conn-2" }),
      );
      expect(denied.detail).toContain("BrowserSurfaceClaimDenied");
    }),
  );

  it.effect("release fences mints already past the held-claim read", () =>
    Effect.gen(function* () {
      const { leases } = yield* harness;
      const resources = createResourcesLeaseApiProvider(resourcesDeps(leases));

      // A mint suspended inside the engine-host lookup — past the claim read
      // but before the registry insert — observes a release that commits
      // while it is suspended.
      const racedMint = (method: "openStream" | "openInput", input: unknown) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const deps = makeDeps(leases);
          const provider = createBrowserFramesApiProvider({
            ...deps,
            broker: {
              frameHubs: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(deps.broker.frameHubs),
              ),
            },
          });
          const outcome = yield* Deferred.make<
            | { readonly ok: true; readonly value: unknown }
            | { readonly ok: false; readonly rejection: InvokeRejection }
          >();
          yield* invoke(provider, method, input, meta(provider)).pipe(
            Effect.match({
              onFailure: (rejection) => ({ ok: false as const, rejection }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
            Effect.flatMap((result) => Deferred.succeed(outcome, result)),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          return { resume, outcome };
        });

      const release = (token: string) =>
        invoke(
          resources,
          "releasePresentation",
          { presentationUrl: token },
          meta(resources),
        ) as Effect.Effect<{ readonly released: boolean }, InvokeRejection>;

      const expectDenied = (
        result:
          | { readonly ok: true; readonly value: unknown }
          | { readonly ok: false; readonly rejection: InvokeRejection },
        name: string,
      ) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          const cause = result.rejection.cause;
          expect(isOperationError(cause) ? cause.detail : String(cause)).toContain(name);
        }
      };

      // A paused openStream resumed after release mints nothing valid, and a
      // second release reports the raced mint produced no record.
      const streamClaim = surfaceToken("slot-stream");
      yield* recordClaim(leases, streamClaim, providerAuthority({ heldSlot: "slot-stream" }));
      const stream = yield* racedMint("openStream", openStreamInput(streamClaim));
      expect((yield* release(streamClaim)).released).toBe(true);
      yield* Deferred.succeed(stream.resume, undefined);
      expectDenied(yield* Deferred.await(stream.outcome), "BrowserStreamTicketDenied");
      expect((yield* release(streamClaim)).released).toBe(false);

      // Same race through openInput.
      const inputClaim = surfaceToken("slot-input");
      yield* recordClaim(leases, inputClaim, providerAuthority({ heldSlot: "slot-input" }));
      const input = yield* racedMint("openInput", openStreamInput(inputClaim));
      expect((yield* release(inputClaim)).released).toBe(true);
      yield* Deferred.succeed(input.resume, undefined);
      expectDenied(yield* Deferred.await(input.outcome), "BrowserInputLeaseDenied");

      // An explicit renewal named by leaseId rides the same fence: release
      // kills both the pending renewal and the lease it would have extended.
      const renewClaim = surfaceToken("slot-renew");
      yield* recordClaim(leases, renewClaim, providerAuthority({ heldSlot: "slot-renew" }));
      const provider = createBrowserFramesApiProvider(makeDeps(leases));
      const issued = (yield* invoke(provider, "openInput", openStreamInput(renewClaim))) as {
        readonly leaseId: string;
        readonly inputTicket: string;
      };
      const renewal = yield* racedMint("openInput", {
        ...openStreamInput(renewClaim),
        leaseId: issued.leaseId,
      });
      expect((yield* release(renewClaim)).released).toBe(true);
      yield* Deferred.succeed(renewal.resume, undefined);
      expectDenied(yield* Deferred.await(renewal.outcome), "BrowserInputLeaseDenied");
      expect(Option.isNone(yield* leases.verify(issued.inputTicket))).toBe(true);
    }),
  );
});
