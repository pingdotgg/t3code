import {
  AssetWorkspacePathValidationError,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import { BROWSER_SESSIONS, WORKSPACE_RESOURCES } from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import { it, expect, describe } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BrowserFrameLeases,
  layer as BrowserFrameLeasesLayer,
} from "../browserFrames/BrowserFrameLeases.ts";
import { createResourcesLeaseApiProvider } from "./resourcesLeaseApi.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const signal = new AbortController().signal;
const WORKSPACE = "/repo/workspace";

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{
  readonly cause: unknown;
}> {}

const makeContext = (): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(WORKSPACE, null),
});

const meta = (
  provider: HostApiProvider,
  callerGenerations: readonly {
    pluginId: string;
    contentHash: string;
    installationGeneration: number;
  }[] = [],
  assertAuthority: () => Promise<void> = async () => {},
): Parameters<HostApiProvider["invoke"]>[4] => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations,
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes: [AuthOrchestrationReadScope],
  },
  assertAuthority,
});

type Deps = Parameters<typeof createResourcesLeaseApiProvider>[0];

const fakeUrl = (kind: string, name = "preview.svg", extra: Record<string, unknown> = {}) =>
  `/api/assets/${Buffer.from(
    JSON.stringify({ version: 1, kind, expiresAt: 999, ...extra }),
  ).toString("base64url")}.sig/${name}`;

/** The claim-token segment of a minted `/api/assets/<token>/<name>` URL. */
const urlToken = (url: string) => url.slice("/api/assets/".length).split("/")[0]!;

const LeasesLive = BrowserFrameLeasesLayer.pipe(Layer.provideMerge(NodeServices.layer));

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  environmentId: "env",
  projects: {
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId: ProjectId.make("project"),
          workspaceRoot: WORKSPACE,
          faviconPath: null,
          deletedAt: null,
        }),
      ),
  },
  threads: {
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId: ProjectId.make("project"),
          worktreePath: null,
          deletedAt: null,
        }),
      ),
  },
  normalizeWorkspaceRoot: (root) => Effect.succeed(root),
  preview: {
    list: () =>
      Effect.succeed({
        sessions: [
          {
            threadId: "thread",
            tabId: "tab-1",
            navStatus: { _tag: "Idle" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-09-14T00:00:00.000Z",
          },
        ],
        serverEpoch: "epoch-1",
        revision: 0,
      }),
  },
  issueUrl: () => Effect.succeed({ relativeUrl: fakeUrl("workspace-file"), expiresAt: 999 }),
  issueBrowserSurface: () =>
    Effect.succeed({
      relativeUrl: fakeUrl("browser-surface", "browser-surface"),
      expiresAt: 999,
      slotId: "slot-1",
    }),
  leases: {
    recordHeldSurfaceClaim: () => Effect.succeed(true),
    heldSurfaceClaim: () => Effect.succeed(Option.none()),
    revokeWhere: () => Effect.void,
    withRetainedConnection: (_connectionId, effect) => effect,
  },
  authorizeGrant: async () => true,
  ...overrides,
});

const invoke = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1],
  context: ViewContext,
  metadata = meta(provider),
) =>
  Effect.tryPromise({
    try: () => Promise.resolve(provider.invoke(method, input, context, signal, metadata)),
    catch: (cause) => new InvokeRejection({ cause }),
  });

const invokeError = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1],
  context: ViewContext,
  metadata = meta(provider),
) =>
  invoke(provider, method, input, context, metadata).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) {
        throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
      }
      return rejection.cause;
    }),
  );

/** Project-scoped context: no threadId, so the scope resolver skips the thread lookup. */
const projectScopedContext = (): ViewContext => ({
  ...makeContext(),
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
  },
});

const workspaceFileInput = {
  resource: { _tag: "workspace-file", threadId: "thread", path: "preview.svg" },
};

describe("t3.resources/lease adapter", () => {
  it.effect("mints a workspace-file lease for a granted caller", () =>
    Effect.gen(function* () {
      let issued: { resource: { _tag: string }; workspaceRoot?: string } | undefined;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueUrl: (input) => {
            issued = input;
            return Effect.succeed({
              relativeUrl: fakeUrl("workspace-file-exact"),
              expiresAt: 1234,
            });
          },
        }),
      );
      const result = (yield* invoke(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        makeContext(),
      )) as { url: string; expiresAt: number; kind: string };
      expect(result.expiresAt).toBe(1234);
      // kind reports the CLAIM actually minted (an image mints an exact claim).
      expect(result.kind).toBe("workspace-file-exact");
      expect(issued?.resource._tag).toBe("workspace-file");
      expect(issued?.workspaceRoot).toBe(WORKSPACE);
      expect(result.url).toContain("/api/assets/");
    }),
  );

  it.effect("mints inside the thread worktree when one exists", () =>
    Effect.gen(function* () {
      let issued: { workspaceRoot?: string } | undefined;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          threads: {
            getById: () =>
              Effect.succeed(
                Option.some({
                  projectId: ProjectId.make("project"),
                  worktreePath: "/repo/worktree",
                  deletedAt: null,
                }),
              ),
          },
          issueUrl: (input) => {
            issued = input;
            return Effect.succeed({ relativeUrl: fakeUrl("workspace-file"), expiresAt: 1 });
          },
        }),
      );
      const context: ViewContext = {
        ...makeContext(),
        workspaceRevision: extensionWorkspaceRevision(WORKSPACE, "/repo/worktree"),
      };
      yield* invoke(provider, "createPresentationUrl", workspaceFileInput, context);
      expect(issued?.workspaceRoot).toBe("/repo/worktree");
    }),
  );

  it.effect("denies a caller missing the kind's grant, before any mint", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          authorizeGrant: async (callerId, grant) => {
            expect(callerId).toBe("caller");
            expect(grant).toBe(WORKSPACE_RESOURCES);
            return false;
          },
          issueUrl: () => {
            minted = true;
            return Effect.die("must not mint");
          },
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseGrantDeniedError");
      expect(error.detail).toContain(WORKSPACE_RESOURCES);
      expect(minted).toBe(false);
    }),
  );

  it.effect("denies an intermediate caller in the chain that lacks the grant", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          authorizeGrant: async (callerId) => callerId !== "mid",
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        makeContext(),
        meta(provider, [{ pluginId: "mid", contentHash: "h", installationGeneration: 1 }]),
      );
      expect(error.detail).toContain("ResourceLeaseGrantDeniedError");
    }),
  );

  it.effect("denies attachment by name — no declared grant in this build", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueUrl: () => {
            minted = true;
            return Effect.die("must not mint");
          },
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        { resource: { _tag: "attachment", attachmentId: "att-1" } },
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseKindDeniedError");
      expect(error.detail).toContain("attachment");
      expect(minted).toBe(false);
    }),
  );

  it.effect("denies kinds outside the contract union by name (media-file)", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(makeDeps());
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        { resource: { _tag: "media-file", threadId: "thread", path: "/abs/video.mp4" } },
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseKindDeniedError");
      expect(error.detail).toContain("media-file");
    }),
  );

  it.effect("a missing thread fails AssetWorkspaceContextNotFoundError — native parity", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(
        makeDeps({ threads: { getById: () => Effect.succeed(Option.none()) } }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        projectScopedContext(),
      );
      expect(error.detail).toContain("AssetWorkspaceContextNotFoundError");
    }),
  );

  it.effect("a soft-deleted thread fails AssetWorkspaceContextNotFoundError", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          threads: {
            getById: () =>
              Effect.succeed(
                Option.some({
                  projectId: ProjectId.make("project"),
                  worktreePath: null,
                  deletedAt: "2026-09-13T00:00:00.000Z",
                }),
              ),
          },
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        projectScopedContext(),
      );
      expect(error.detail).toContain("AssetWorkspaceContextNotFoundError");
    }),
  );

  it.effect("a resource thread outside the granted project reads as not-found", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          threads: {
            getById: ({ threadId }) =>
              Effect.succeed(
                Option.some(
                  threadId === ThreadId.make("other-thread")
                    ? {
                        projectId: ProjectId.make("other-project"),
                        worktreePath: null,
                        deletedAt: null,
                      }
                    : {
                        projectId: ProjectId.make("project"),
                        worktreePath: null,
                        deletedAt: null,
                      },
                ),
              ),
          },
        }),
      );
      // The context thread stays inside the granted project; the resource
      // thread points elsewhere — reported as not-found, not a distinct
      // denial, so a granted caller cannot probe cross-project thread ids.
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        { resource: { _tag: "workspace-file", threadId: "other-thread", path: "a.svg" } },
        makeContext(),
      );
      expect(error.detail).toContain("AssetWorkspaceContextNotFoundError");
    }),
  );

  it.effect("mints a project-favicon lease rooted at the granted project", () =>
    Effect.gen(function* () {
      let issued: { resource: { _tag: string }; projectFaviconPath?: string } | undefined;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          projects: {
            getById: () =>
              Effect.succeed(
                Option.some({
                  projectId: ProjectId.make("project"),
                  workspaceRoot: WORKSPACE,
                  faviconPath: "public/favicon.svg",
                  deletedAt: null,
                }),
              ),
          },
          issueUrl: (input) => {
            issued = input;
            return Effect.succeed({
              relativeUrl: fakeUrl("project-favicon", "favicon.svg"),
              expiresAt: 42,
            });
          },
        }),
      );
      const result = (yield* invoke(
        provider,
        "createPresentationUrl",
        { resource: { _tag: "project-favicon", cwd: WORKSPACE } },
        makeContext(),
      )) as { url: string; expiresAt: number; kind: string };
      expect(result.kind).toBe("project-favicon");
      expect(result.expiresAt).toBe(42);
      expect(issued?.projectFaviconPath).toBe("public/favicon.svg");
    }),
  );

  it.effect("a project-favicon cwd outside the granted project is denied", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(makeDeps());
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        { resource: { _tag: "project-favicon", cwd: "/elsewhere" } },
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseKindDeniedError");
      expect(error.detail).toContain("outside the granted project scope");
    }),
  );

  it.effect("native mint errors keep their tag (outside-root path)", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueUrl: () =>
            Effect.fail(
              new AssetWorkspacePathValidationError({
                resource: { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "x" },
                cause: new Error("escapes"),
              }),
            ),
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        makeContext(),
      );
      expect(error.detail).toContain("AssetWorkspacePathValidationError");
    }),
  );

  it.effect("re-checks authority after minting — revocation cancels the result", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueUrl: () => {
            minted = true;
            return Effect.succeed({ relativeUrl: fakeUrl("workspace-file"), expiresAt: 1 });
          },
        }),
      );
      let issued = false;
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        workspaceFileInput,
        makeContext(),
        meta(provider, [], async () => {
          issued = minted;
          throw new Error("revoked");
        }),
      );
      expect(error.detail).toContain("revoked");
      expect(issued).toBe(true);
    }),
  );

  it.effect("reports honest capabilities", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(makeDeps());
      const result = (yield* invoke(provider, "getCapabilities", {}, makeContext())) as {
        supportedKinds: string[];
      };
      expect(result.supportedKinds).toEqual([
        "workspace-file",
        "project-favicon",
        "browser-surface",
      ]);
    }),
  );

  it.effect("requires the orchestration read principal", () =>
    Effect.gen(function* () {
      const provider = createResourcesLeaseApiProvider(makeDeps());
      const { principal: _dropped, ...anonymous } = meta(provider);
      const error = yield* invokeError(provider, "getCapabilities", {}, makeContext(), anonymous);
      expect(error.detail).toContain("authority is unavailable");
    }),
  );

  const browserSurfaceInput = {
    resource: {
      _tag: "browser-surface",
      threadId: "thread",
      tabId: "tab-1",
      serverEpoch: "epoch-1",
      allowedCommands: ["attach", "present"],
    },
  };

  it.effect("mints a browser-surface lease under the sessions grant, bound to the live epoch", () =>
    Effect.gen(function* () {
      let grant: string | undefined;
      let issued:
        | {
            environmentId: string;
            threadId: string;
            tabId: string;
            serverEpoch: string;
            allowedCommands: readonly string[];
          }
        | undefined;
      let held: Parameters<Deps["leases"]["recordHeldSurfaceClaim"]>[0] | undefined;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          authorizeGrant: async (_callerId, requested) => {
            grant = requested;
            return true;
          },
          issueBrowserSurface: (input) => {
            issued = input;
            return Effect.succeed({
              relativeUrl: fakeUrl("browser-surface", "browser-surface"),
              expiresAt: 7,
              slotId: "slot-1",
            });
          },
          leases: {
            recordHeldSurfaceClaim: (claim) => {
              held = claim;
              return Effect.succeed(true);
            },
            heldSurfaceClaim: () => Effect.succeed(Option.none()),
            revokeWhere: () => Effect.void,
            withRetainedConnection: (_connectionId, effect) => effect,
          },
        }),
      );
      const result = (yield* invoke(
        provider,
        "createPresentationUrl",
        browserSurfaceInput,
        makeContext(),
      )) as { url: string; expiresAt: number; kind: string };
      expect(result.kind).toBe("browser-surface");
      expect(result.expiresAt).toBe(7);
      expect(grant).toBe(BROWSER_SESSIONS);
      expect(issued).toEqual({
        environmentId: "env",
        threadId: "thread",
        tabId: "tab-1",
        // The live manager epoch, never the caller-claimed value.
        serverEpoch: "epoch-1",
        allowedCommands: ["attach", "present"],
      });
      // The mint must register the claim as held: the frames mint only honors
      // tokens that passed through this path under the same authority.
      expect(held).toMatchObject({
        token: expect.any(String),
        session: {
          environmentId: "env",
          threadId: "thread",
          tabId: "tab-1",
          serverEpoch: "epoch-1",
        },
        allowedCommands: ["attach", "present"],
        expiresAt: 7,
      });
      // The registered authority is what `browserFrameAuthorityKey` binds the
      // frames mint to — wrong caller identity or slot would never match.
      expect(held?.authority).toMatchObject({
        kind: "extension",
        callerId: "caller",
        rootCallerId: "root",
        heldSlot: "slot-1",
        grants: [BROWSER_SESSIONS],
      });
      const heldContext = held?.authority.kind === "extension" ? held.authority.context : undefined;
      expect(heldContext).toMatchObject({ resource: { projectId: "project" } });
    }),
  );

  it.effect("denies browser-surface without the sessions grant, before any mint", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          authorizeGrant: async () => false,
          issueBrowserSurface: () => {
            minted = true;
            return Effect.die("must not mint");
          },
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        browserSurfaceInput,
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseGrantDeniedError");
      expect(error.detail).toContain(BROWSER_SESSIONS);
      expect(minted).toBe(false);
    }),
  );

  it.effect("denies a stale epoch by name — a lease never re-binds", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          preview: {
            list: () => Effect.succeed({ sessions: [], serverEpoch: "epoch-2", revision: 3 }),
          },
          issueBrowserSurface: () => {
            minted = true;
            return Effect.die("must not mint");
          },
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        browserSurfaceInput,
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseSessionBindingError");
      expect(error.detail).toContain("epoch");
      expect(minted).toBe(false);
    }),
  );

  it.effect("denies a session that does not exist on the claimed thread", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          preview: {
            list: () => Effect.succeed({ sessions: [], serverEpoch: "epoch-1", revision: 0 }),
          },
          issueBrowserSurface: () => {
            minted = true;
            return Effect.die("must not mint");
          },
        }),
      );
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        browserSurfaceInput,
        makeContext(),
      );
      expect(error.detail).toContain("ResourceLeaseSessionBindingError");
      expect(error.detail).toContain("tab-1");
      expect(minted).toBe(false);
    }),
  );

  it.effect("collapses missing and cross-project threads into one binding denial", () =>
    Effect.gen(function* () {
      const contextThread = {
        projectId: ProjectId.make("project"),
        worktreePath: null,
        deletedAt: null,
      };
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          threads: {
            getById: ({ threadId }) =>
              Effect.succeed(
                threadId === ThreadId.make("thread") ? Option.some(contextThread) : Option.none(),
              ),
          },
          issueBrowserSurface: () => Effect.die("must not mint"),
        }),
      );
      const missing = yield* invokeError(
        provider,
        "createPresentationUrl",
        {
          resource: { ...browserSurfaceInput.resource, threadId: "ghost" },
        },
        makeContext(),
      );
      expect(missing.detail).toContain("ResourceLeaseSessionBindingError");

      const crossProject = createResourcesLeaseApiProvider(
        makeDeps({
          threads: {
            getById: ({ threadId }) =>
              Effect.succeed(
                Option.some(
                  threadId === ThreadId.make("thread")
                    ? contextThread
                    : {
                        projectId: ProjectId.make("other-project"),
                        worktreePath: null,
                        deletedAt: null,
                      },
                ),
              ),
          },
          issueBrowserSurface: () => Effect.die("must not mint"),
        }),
      );
      const foreign = yield* invokeError(
        crossProject,
        "createPresentationUrl",
        {
          resource: { ...browserSurfaceInput.resource, threadId: "foreign" },
        },
        makeContext(),
      );
      // Same name and message — no thread-existence oracle across projects.
      expect(foreign.detail).toBe(missing.detail);
    }),
  );

  it.effect("rejects malformed command sets at the schema boundary", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueBrowserSurface: () => {
            minted = true;
            return Effect.die("must not mint");
          },
        }),
      );
      for (const allowedCommands of [[], ["navigate"], ["attach", "execute"]]) {
        const error = yield* invokeError(
          provider,
          "createPresentationUrl",
          { resource: { ...browserSurfaceInput.resource, allowedCommands } },
          makeContext(),
        );
        expect(error.detail).toContain("Invalid resource lease request input.");
      }
      expect(minted).toBe(false);
    }),
  );

  it.effect("re-checks authority after a browser-surface mint — revocation cancels", () =>
    Effect.gen(function* () {
      let minted = false;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueBrowserSurface: () => {
            minted = true;
            return Effect.succeed({
              relativeUrl: fakeUrl("browser-surface", "browser-surface"),
              expiresAt: 1,
              slotId: "slot-1",
            });
          },
        }),
      );
      let issued = false;
      const error = yield* invokeError(
        provider,
        "createPresentationUrl",
        browserSurfaceInput,
        makeContext(),
        meta(provider, [], async () => {
          issued = minted;
          throw new Error("revoked");
        }),
      );
      expect(error.detail).toContain("revoked");
      expect(issued).toBe(true);
    }),
  );

  const releaseInput = {
    resource: {
      ...browserSurfaceInput.resource,
      allowedCommands: ["attach", "present", "release"],
    },
  };

  it.effect("two simultaneous mints acquire distinct held presentation slots", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      let mintCount = 0;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueBrowserSurface: () => {
            mintCount += 1;
            const slotId = `slot-${mintCount}`;
            return Effect.succeed({
              relativeUrl: fakeUrl("browser-surface", "browser-surface", { slotId }),
              expiresAt: 4_102_444_800_000,
              slotId,
            });
          },
          leases,
        }),
      );
      // Equivalent claims minted at the same moment — the defect this guards
      // against is both presentations collapsing onto one held identity.
      const [a, b] = yield* Effect.all(
        [
          invoke(provider, "createPresentationUrl", releaseInput, makeContext()),
          invoke(provider, "createPresentationUrl", releaseInput, makeContext()),
        ],
        { concurrency: 2 },
      );
      const urlA = (a as { url: string }).url;
      const urlB = (b as { url: string }).url;
      expect(urlA).not.toBe(urlB);
      const heldA = yield* leases.heldSurfaceClaim(urlToken(urlA));
      const heldB = yield* leases.heldSurfaceClaim(urlToken(urlB));
      if (Option.isNone(heldA) || Option.isNone(heldB)) {
        throw new Error("both claims must be registered as held");
      }
      const slotA =
        heldA.value.authority.kind === "extension" ? heldA.value.authority.heldSlot : undefined;
      const slotB =
        heldB.value.authority.kind === "extension" ? heldB.value.authority.heldSlot : undefined;
      expect(slotA).toBeDefined();
      expect(slotB).toBeDefined();
      // Distinct slots → distinct authority keys → the frames mint can never
      // seat the two presentations on one another's leases.
      expect(slotA).not.toBe(slotB);
      const leaseA = yield* leases.issueInputLease({
        authority: heldA.value.authority,
        session: heldA.value.session,
      });
      const leaseB = yield* leases.issueInputLease({
        authority: heldB.value.authority,
        session: heldB.value.session,
      });
      if (Option.isNone(leaseA) || Option.isNone(leaseB)) {
        throw new Error("each held slot must mint its own input lease");
      }
      expect(leaseA.value.leaseId).not.toBe(leaseB.value.leaseId);
      expect(Option.isSome(yield* leases.verify(leaseA.value.inputTicket))).toBe(true);
      expect(Option.isSome(yield* leases.verify(leaseB.value.inputTicket))).toBe(true);
    }).pipe(Effect.provide(LeasesLive)),
  );

  it.effect(
    "releasePresentation retires the held claim and every frame record under its slot",
    () =>
      Effect.gen(function* () {
        const leases = yield* BrowserFrameLeases;
        const provider = createResourcesLeaseApiProvider(
          makeDeps({
            issueBrowserSurface: () =>
              Effect.succeed({
                relativeUrl: fakeUrl("browser-surface", "browser-surface", {
                  slotId: "slot-1",
                }),
                expiresAt: 4_102_444_800_000,
                slotId: "slot-1",
              }),
            leases,
          }),
        );
        const minted = (yield* invoke(
          provider,
          "createPresentationUrl",
          releaseInput,
          makeContext(),
        )) as { url: string };
        const token = urlToken(minted.url);
        const held = yield* leases.heldSurfaceClaim(token);
        if (Option.isNone(held)) throw new Error("minted claim must be held");
        // The records the frames mint creates under this presentation's slot.
        const streamTicket = yield* leases.issueStreamTicket({
          authority: held.value.authority,
          session: held.value.session,
        });
        if (Option.isNone(streamTicket)) throw new Error("stream ticket must mint");
        const inputLease = yield* leases.issueInputLease({
          authority: held.value.authority,
          session: held.value.session,
        });
        if (Option.isNone(inputLease)) throw new Error("input lease must mint");
        const released = (yield* invoke(
          provider,
          "releasePresentation",
          { presentationUrl: minted.url },
          makeContext(),
        )) as { released: boolean };
        expect(released).toEqual({ released: true });
        // Claim, stream ticket, and input lease all die with the release.
        expect(Option.isNone(yield* leases.heldSurfaceClaim(token))).toBe(true);
        expect(Option.isNone(yield* leases.verify(streamTicket.value.ticket))).toBe(true);
        expect(Option.isNone(yield* leases.verify(inputLease.value.inputTicket))).toBe(true);
        const lease = yield* leases.resolveLease(inputLease.value.leaseId);
        expect(Option.isNone(lease) || lease.value.revoked).toBe(true);
        // Releasing twice is a no-op, not an error.
        const again = (yield* invoke(
          provider,
          "releasePresentation",
          { presentationUrl: minted.url },
          makeContext(),
        )) as { released: boolean };
        expect(again).toEqual({ released: false });
      }).pipe(Effect.provide(LeasesLive)),
  );

  it.effect("releasePresentation refuses a caller that does not hold the claim", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueBrowserSurface: () =>
            Effect.succeed({
              relativeUrl: fakeUrl("browser-surface", "browser-surface", {
                slotId: "slot-1",
              }),
              expiresAt: 4_102_444_800_000,
              slotId: "slot-1",
            }),
          leases,
        }),
      );
      const minted = (yield* invoke(
        provider,
        "createPresentationUrl",
        releaseInput,
        makeContext(),
      )) as { url: string };
      const token = urlToken(minted.url);
      // A different caller identity — same everything else — cannot retire it.
      const denied = (yield* invoke(
        provider,
        "releasePresentation",
        { presentationUrl: minted.url },
        makeContext(),
        { ...meta(provider), callerId: "other-caller" },
      )) as { released: boolean };
      expect(denied).toEqual({ released: false });
      expect(Option.isSome(yield* leases.heldSurfaceClaim(token))).toBe(true);
    }).pipe(Effect.provide(LeasesLive)),
  );

  it.effect("releasePresentation refuses a claim minted without the release command", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueBrowserSurface: () =>
            Effect.succeed({
              relativeUrl: fakeUrl("browser-surface", "browser-surface", {
                slotId: "slot-1",
              }),
              expiresAt: 4_102_444_800_000,
              slotId: "slot-1",
            }),
          leases,
        }),
      );
      // browserSurfaceInput's allowedCommands lack "release".
      const minted = (yield* invoke(
        provider,
        "createPresentationUrl",
        browserSurfaceInput,
        makeContext(),
      )) as { url: string };
      const denied = (yield* invoke(
        provider,
        "releasePresentation",
        { presentationUrl: minted.url },
        makeContext(),
      )) as { released: boolean };
      expect(denied).toEqual({ released: false });
      expect(Option.isSome(yield* leases.heldSurfaceClaim(urlToken(minted.url)))).toBe(true);
    }).pipe(Effect.provide(LeasesLive)),
  );

  it.effect("an aborted browser-surface acquisition leaves no held claim behind", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      let markSuspended: (() => void) | undefined;
      const suspended = new Promise<void>((resolve) => {
        markSuspended = resolve;
      });
      const provider = createResourcesLeaseApiProvider(
        makeDeps({
          issueBrowserSurface: () =>
            Effect.succeed({
              relativeUrl: fakeUrl("browser-surface", "browser-surface", { slotId: "slot-1" }),
              expiresAt: 4_102_444_800_000,
              slotId: "slot-1",
            }),
          leases,
        }),
      );
      // The post-mint authority re-check is the abortible tail of an
      // acquisition — suspend it so the caller's abort lands while the claim
      // could otherwise be held with a URL nobody will ever receive.
      const controller = new AbortController();
      const invocation = provider.invoke(
        "createPresentationUrl",
        releaseInput,
        makeContext(),
        controller.signal,
        meta(provider, [], async () => {
          markSuspended?.();
          await new Promise<never>(() => {});
        }),
      );
      yield* Effect.promise(() => suspended);
      controller.abort();
      const exit = yield* Effect.exit(Effect.promise(() => Promise.resolve(invocation)));
      expect(Exit.isSuccess(exit)).toBe(false);
      // The claim's token never reached the caller, so nothing may stay held.
      const token = urlToken(fakeUrl("browser-surface", "browser-surface", { slotId: "slot-1" }));
      expect(Option.isNone(yield* leases.heldSurfaceClaim(token))).toBe(true);
    }).pipe(Effect.provide(LeasesLive)),
  );
});
