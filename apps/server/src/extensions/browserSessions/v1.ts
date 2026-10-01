/**
 * `t3.browser/sessions@1.2.0` (serving the frozen 1.1.0 and 1.0.0 consumers
 * too) — public browser-session metadata capability.
 *
 * This adapter projects the server's native `PreviewManager` state through
 * the public contract and never exposes webview handles, partitions, preload
 * URLs, evaluation endpoints, or presentation slots. Metadata writes (open,
 * resize, close) record acceptance, never engine execution. Page commands
 * (back … closeDevTools) route to the authenticated desktop engine host that
 * owns the session (see `preview/BrowserEngineHosts.ts`); with no owner they
 * fail by name. `navigate` records the request, then routes to the owner
 * when one exists; an ownerless session keeps the recorded request. The
 * DevTools methods' own `t3.browser/devtools` grant is enforced by the
 * broker from their `requiredGrants`; the adapter additionally limits them
 * to sessions the calling installation opened.
 * Navigation honesty compares the dispatch-side
 * request revision against the last owner-host report carried by
 * `PreviewSessionDetail` (see `Manager.ts`). Favicons ride as a
 * ref into the bounded per-project asset store (`faviconAssets.ts`), resolved
 * through `getFavicon` — never as bytes on the stream.
 * `setPictureInPicture` is an engine verb under its own grant (the broker
 * enforces the method's `requiredGrants`); it additionally refuses a guest
 * that is recovering or crashed by name, since there is no live page to pop out.
 */
import {
  type BrowserEngineCommand,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BrowserProfileId,
  ExtensionOperationError,
  PreviewTabId,
  PreviewViewportSetting,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  BROWSER_SESSION_COMMANDS,
  BROWSER_SESSION_FAVICON_REF_MAX_LENGTH,
  BROWSER_SESSION_LIMIT,
  BROWSER_SESSION_ZOOM_LEVELS,
  browserSessionsApi,
  type BrowserSession,
  type BrowserSessionCapabilities,
  type BrowserSessionCloseResult,
  type BrowserSessionEngine,
  type BrowserSessionFavicon,
  type BrowserSessionFailureCode,
  type BrowserSessionNavigation,
  type BrowserSessionReceipt,
  type BrowserSessionsSnapshot,
  type BrowserSessionStreamValue,
  type BrowserSessionViewport,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import * as BrowserEngineHosts from "../../preview/BrowserEngineHosts.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { makeExtensionScopeResolver } from "../scope.ts";
import type { BrowserFaviconAssets } from "./faviconAssets.ts";

const OPERATION = "browser.sessions";
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_QUEUED_EVENTS = 128;
const MAX_QUEUED_BYTES = 512 * 1024;
const WRITE_METHODS = new Set(["open", "navigate", "close", ...BROWSER_SESSION_COMMANDS]);

export const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const isOperationError = Schema.is(ExtensionOperationError);
/** Named denials keep a stable prefix so callers can branch on the name. */
export const named = (operation: string, name: string, detail: string) =>
  failure(operation, `${name}: ${detail}`);

/** Native `_tag`s stay visible; only untagged causes collapse to a message. */
export const operationError = (operation: string) => (cause: unknown) => {
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
  const message = cause instanceof Error ? cause.message : "Browser session operation failed.";
  return failure(operation, `${tag ? `${tag}: ` : ""}${message}`.slice(0, 512));
};

/**
 * `did-fail-load` reports raw Chromium net error codes. Only the well-known
 * constants map onto the closed enum; anything else is `unknown`, and the
 * native description string never crosses the boundary.
 */
const failureCode = (code: number): BrowserSessionFailureCode => {
  if (code <= -200 && code >= -299) return "certificate"; // ERR_CERT_*
  switch (code) {
    case -3:
      return "aborted"; // ERR_ABORTED
    case -105:
    case -137:
      return "dns"; // ERR_NAME_NOT_RESOLVED, ERR_NAME_RESOLUTION_FAILED
    case -106:
      return "offline"; // ERR_INTERNET_DISCONNECTED
    case -7:
    case -118:
      return "timeout"; // ERR_TIMED_OUT, ERR_CONNECTION_TIMED_OUT
    case -102:
      return "refused"; // ERR_CONNECTION_REFUSED
    case -101:
      return "reset"; // ERR_CONNECTION_RESET
    case -20:
      return "blocked"; // ERR_BLOCKED_BY_CLIENT
    case -310:
      return "redirect"; // ERR_TOO_MANY_REDIRECTS
    case -300:
      return "invalid-url"; // ERR_INVALID_URL
    default:
      return "unknown";
  }
};

/** Page verbs that need an attached guest; the rest are metadata writes. */
const ENGINE_COMMANDS = BROWSER_SESSION_COMMANDS.filter((command) => command !== "resize");

/**
 * Engine state comes only from an authenticated owner claim and its fenced
 * reports. Without a claim the honest state is unavailable, and generation is
 * null rather than fabricated. A host whose recovery gave up reads as crashed
 * with a named reason; the public state set has no separate "exhausted".
 */
const projectEngine = (
  engine: PreviewManager.PreviewSessionEngine | null,
): BrowserSessionEngine => {
  if (engine === null)
    return { state: "unavailable", generation: null, reason: "desktop-required" };
  const { generation } = engine;
  switch (engine.lifecycle) {
    case "crashed":
      return { state: "crashed", generation };
    case "exhausted":
      return { state: "crashed", generation, reason: "recovery-exhausted" };
    case "recovering":
      return { state: "recovering", generation };
    case null:
      return { state: engine.status === null ? "starting" : "ready", generation };
  }
};

const CommandGuardFields = {
  tabId: PreviewTabId,
  serverEpoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  expectedEngineGeneration: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
} satisfies Schema.Struct.Fields;

const closedDecoder = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.decodeUnknownEffect(Schema.Struct(fields), { onExcessProperty: "error" });

const decodeOpenInput = closedDecoder({
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  viewport: Schema.optional(PreviewViewportSetting),
  profileId: Schema.optional(BrowserProfileId),
});
const decodeCloseInput = closedDecoder({
  tabId: PreviewTabId,
  serverEpoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
const decodeNavigateInput = closedDecoder({
  ...CommandGuardFields,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
const decodeGuardInput = closedDecoder(CommandGuardFields);
const decodeZoomInput = closedDecoder({
  ...CommandGuardFields,
  zoomFactor: Schema.Literals(BROWSER_SESSION_ZOOM_LEVELS),
});
const decodeAppearanceInput = closedDecoder({
  ...CommandGuardFields,
  appearance: Schema.Literals(["system", "light", "dark"]),
});
const decodeMutedInput = closedDecoder({ ...CommandGuardFields, muted: Schema.Boolean });
const decodePictureInPictureInput = closedDecoder({ ...CommandGuardFields, open: Schema.Boolean });
const decodeResizeInput = closedDecoder({
  ...CommandGuardFields,
  viewport: PreviewViewportSetting,
});
const EmptyInput = Schema.Record(Schema.String, Schema.Never);
const decodeFaviconInput = closedDecoder({
  ref: TrimmedNonEmptyString.check(Schema.isMaxLength(BROWSER_SESSION_FAVICON_REF_MAX_LENGTH)),
});
const decodeReadInput = Schema.decodeUnknownEffect(EmptyInput, {
  onExcessProperty: "error",
});
const decodeEventsInput = Schema.decodeUnknownSync(EmptyInput, {
  onExcessProperty: "error",
});

const projectNavigation = (
  detail: PreviewManager.PreviewSessionDetail,
): BrowserSessionNavigation => {
  const { snapshot, navigation } = detail;
  const reported = detail.engine?.status ?? null;
  const lifecycle = detail.engine?.lifecycle ?? null;
  if (lifecycle === "crashed" || lifecycle === "exhausted") {
    // The owner reported the guest dead; its last page is not still loaded.
    const last = reported?.navStatus ?? snapshot.navStatus;
    return {
      kind: "failed",
      url: last._tag === "Idle" ? navigation.requestedUrl : last.url,
      title: last._tag === "Idle" ? "" : last.title,
      failureCode: "crash",
    };
  }
  const engineAuthored =
    reported !== null &&
    navigation.engineRevision !== null &&
    (navigation.requestRevision === null ||
      navigation.engineRevision >= navigation.requestRevision);
  if (!engineAuthored) {
    const native = snapshot.navStatus;
    if (native._tag === "Idle") return { kind: "idle", url: null, title: "" };
    // Dispatch or an unfenced legacy report wrote navStatus — the only
    // honest kind is "pending"; navStatus Success here is NOT proof of load.
    return {
      kind: "pending",
      url: navigation.requestedUrl ?? native.url,
      title: native.title,
    };
  }
  const nav = reported.navStatus;
  switch (nav._tag) {
    case "Idle":
      return { kind: "idle", url: null, title: "" };
    case "Loading":
      return { kind: "loading", url: nav.url, title: nav.title };
    case "Success":
      return { kind: "loaded", url: nav.url, title: nav.title };
    case "LoadFailed":
      return {
        kind: "failed",
        url: nav.url,
        title: nav.title,
        failureCode: failureCode(nav.code),
      };
  }
};

const origin = (url: string | null) => {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Page state is read only from the owner host's fenced report; without one
 * the overlay fields are null, never fabricated defaults. A reported favicon
 * is stored through `captureFavicon` and projected as its ref, and only
 * while it belongs to the current page's origin (the native same-origin
 * rule) — bytes never enter the projection.
 */
export const projectSession = (
  detail: PreviewManager.PreviewSessionDetail,
  captureFavicon: (dataUrl: string) => string | null,
): BrowserSession => {
  const status = detail.engine?.status ?? null;
  const navigation = projectNavigation(detail);
  const favicon = status?.favicon ?? null;
  const faviconOrigin = favicon === null ? null : origin(favicon.pageUrl);
  const faviconRef =
    favicon !== null && faviconOrigin !== null && faviconOrigin === origin(navigation.url)
      ? captureFavicon(favicon.dataUrl)
      : null;
  return {
    tabId: detail.snapshot.tabId,
    requestedUrl: detail.navigation.requestedUrl,
    navigation,
    canGoBack: status?.canGoBack ?? false,
    canGoForward: status?.canGoForward ?? false,
    viewport: (detail.snapshot.viewport ?? { _tag: "fill" }) as BrowserSessionViewport,
    ...(detail.snapshot.profileId === undefined ? {} : { profileId: detail.snapshot.profileId }),
    engine: projectEngine(detail.engine),
    zoomFactor: status?.zoomFactor ?? null,
    appearance: status?.appearance ?? null,
    audioMuted: status?.audioMuted ?? null,
    audible: status?.audible ?? null,
    devToolsOpen: status?.devToolsOpen ?? null,
    pictureInPicture: status?.pictureInPicture ?? null,
    ...(faviconRef === null ? {} : { faviconRef }),
  };
};

const sessionBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Bounded stream value. Removal reasons resolve at pull time (the thread may
 * be deleted between the native close and delivery), so entries are thunks.
 * `removal` marks entries that stay deliverable after the scope dies: a
 * deleted thread still owes the caller its honest `session-removed` data
 * before the terminal `scope-invalidated` close.
 */
interface QueuedValue {
  readonly make: () => Promise<ApiStreamEvent>;
  readonly bytes: number;
  readonly removal?: boolean;
}

export function createBrowserSessionsApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly preview: Pick<
      PreviewManager.PreviewManager["Service"],
      "open" | "navigate" | "resize" | "close" | "listDetails" | "subscribeDetails"
    >;
    readonly engineHosts: Pick<
      BrowserEngineHosts.BrowserEngineHosts["Service"],
      "dispatch" | "hasHost"
    >;
    /** The environment's one favicon store, shared with `t3.browser/profiles`. */
    readonly favicons: BrowserFaviconAssets;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const favicons = dependencies.favicons;
  /** The projector for one resolved project; favicon assets never cross projects. */
  const projectorFor = (projectId: string | undefined) => {
    const capture = (dataUrl: string) =>
      projectId === undefined ? null : favicons.capture(projectId, dataUrl);
    return (detail: PreviewManager.PreviewSessionDetail) => projectSession(detail, capture);
  };

  const authorized = (principal: HostApiPrincipal | undefined, write: boolean) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationReadScope) &&
    (!write || principal.scopes.includes(AuthOrchestrationOperateScope));

  const postChecks = (
    operation: string,
    scopeContext: ViewContext,
    metadata: HostApiInvocationMetadata,
    signal: AbortSignal,
  ): Effect.Effect<void, ExtensionOperationError> =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(operation, "Browser sessions authority was revoked."),
      });
      yield* resolve(scopeContext);
      signal.throwIfAborted();
    });

  const sessionDetail = (listed: PreviewManager.PreviewListDetailsResult, tabId: string) =>
    listed.sessions.find((entry) => entry.snapshot.tabId === tabId);

  const guardEpoch = Effect.fn("BrowserSessions.guardEpoch")(function* (
    operation: string,
    listed: PreviewManager.PreviewListDetailsResult,
    input: { readonly serverEpoch: string },
  ) {
    if (input.serverEpoch !== listed.serverEpoch) {
      return yield* named(
        operation,
        "BrowserStaleServerEpoch",
        "the request epoch does not match the live session epoch.",
      );
    }
  });

  /**
   * A null expected generation is unfenced; a non-null one must name the
   * guest that currently renders the session.
   */
  const guardGeneration = Effect.fn("BrowserSessions.guardGeneration")(function* (
    operation: string,
    detail: PreviewManager.PreviewSessionDetail,
    expectedEngineGeneration: string | null,
  ) {
    if (
      expectedEngineGeneration !== null &&
      expectedEngineGeneration !== (detail.engine?.generation ?? null)
    ) {
      return yield* named(
        operation,
        "BrowserStaleEngineGeneration",
        detail.engine === null
          ? "the expected engine generation cannot match: no authenticated engine is attached."
          : "the expected engine generation was replaced.",
      );
    }
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
      const operation = `${OPERATION}.${method}`;
      const write = WRITE_METHODS.has(method);
      if (!authorized(metadata.principal, write) || !metadata.assertAuthority) {
        return yield* failure(operation, "Browser sessions authority is unavailable.");
      }
      const scope = yield* resolve(context);
      const threadIdRaw = scope.context.resource.threadId;
      if (!threadIdRaw) {
        return yield* failure(operation, "Browser sessions require a thread-scoped context.");
      }
      const threadId = ThreadId.make(threadIdRaw);
      const project = projectorFor(scope.context.resource.projectId);
      const listDetails = () =>
        dependencies.preview
          .listDetails({ threadId })
          .pipe(Effect.mapError(operationError(operation)));

      if (method === "getCapabilities") {
        yield* decodeReadInput(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserSessionInputError",
              "getCapabilities input fails the declared schema.",
            ),
          ),
        );
        const hasHost = yield* dependencies.engineHosts.hasHost;
        yield* postChecks(operation, scope.context, metadata, signal);
        return {
          metadata: { supported: true },
          // Presentation needs a host-issued slot —
          // a named deferral even while an engine host is registered.
          presentation: { supported: false, reason: "desktop-required" },
          // Discovery is environment-wide: page verbs are listed while any
          // authenticated desktop engine host is registered (web, mobile and
          // remote-only environments advertise resize alone). Whether a given
          // session can run them is `session.engine.state`; an ownerless
          // session still refuses them by name.
          commands: hasHost ? ["resize", ...ENGINE_COMMANDS] : ["resize"],
        } satisfies BrowserSessionCapabilities;
      }

      if (method === "list") {
        yield* decodeReadInput(input).pipe(
          Effect.mapError(() =>
            named(operation, "BrowserSessionInputError", "list input fails the declared schema."),
          ),
        );
        const listed = yield* listDetails();
        if (listed.sessions.length > BROWSER_SESSION_LIMIT) {
          return yield* named(
            operation,
            "BrowserSessionLimitExceeded",
            `thread holds ${listed.sessions.length} sessions; the limit is ${BROWSER_SESSION_LIMIT}.`,
          );
        }
        const sessions = listed.sessions.map(project);
        if (
          sessionBytes({ serverEpoch: listed.serverEpoch, revision: listed.revision, sessions }) >
          MAX_SNAPSHOT_BYTES
        ) {
          return yield* named(
            operation,
            "BrowserSessionLimitExceeded",
            "the complete session snapshot exceeds 512 KiB.",
          );
        }
        yield* postChecks(operation, scope.context, metadata, signal);
        return {
          serverEpoch: listed.serverEpoch,
          revision: listed.revision,
          sessions,
        } satisfies BrowserSessionsSnapshot;
      }

      if (method === "getFavicon") {
        const safe = yield* decodeFaviconInput(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserSessionInputError",
              "getFavicon input fails the declared schema.",
            ),
          ),
        );
        const projectId = scope.context.resource.projectId;
        const dataUrl = projectId === undefined ? null : favicons.read(projectId, safe.ref);
        yield* postChecks(operation, scope.context, metadata, signal);
        if (dataUrl === null) {
          return yield* named(
            operation,
            "BrowserFaviconNotFound",
            "the favicon ref is unknown or was evicted; render the fallback tier.",
          );
        }
        return { ref: safe.ref, dataUrl } satisfies BrowserSessionFavicon;
      }

      if (method === "open") {
        const safe = yield* decodeOpenInput(input).pipe(
          Effect.mapError(() =>
            named(operation, "BrowserSessionInputError", "open input fails the declared schema."),
          ),
        );
        if (safe.profileId !== undefined) {
          // Choosing a profile is the t3.browser/profiles grant's authority;
          // operate alone must not reach another profile's cookie jar.
          return yield* named(
            operation,
            "BrowserProfileGrantRequired",
            "opening under a named profile goes through t3.browser/profiles.open (t3.browser/profiles grant).",
          );
        }
        const before = yield* listDetails();
        if (before.sessions.length >= BROWSER_SESSION_LIMIT) {
          return yield* named(
            operation,
            "BrowserSessionLimitExceeded",
            `thread already holds ${BROWSER_SESSION_LIMIT} sessions.`,
          );
        }
        const snapshot = yield* dependencies.preview
          .open(
            {
              threadId,
              ...(safe.url === undefined ? {} : { url: safe.url }),
              ...(safe.viewport === undefined ? {} : { viewport: safe.viewport }),
              ...(safe.profileId === undefined ? {} : { profileId: safe.profileId }),
            },
            // Ownership comes from the broker's caller identity, never input.
            { extensionInstallationId: metadata.callerId },
          )
          .pipe(Effect.mapError(operationError(operation)));
        yield* postChecks(operation, scope.context, metadata, signal);
        const after = yield* listDetails();
        const detail = sessionDetail(after, snapshot.tabId);
        if (!detail) {
          return yield* failure(operation, "Opened session is not present in the post-open read.");
        }
        return {
          commandId: NodeCrypto.randomUUID(),
          outcome: "accepted",
          serverEpoch: after.serverEpoch,
          revision: after.revision,
          session: project(detail),
        } satisfies BrowserSessionReceipt;
      }

      if (method === "close") {
        const safe = yield* decodeCloseInput(input).pipe(
          Effect.mapError(() =>
            named(operation, "BrowserSessionInputError", "close input fails the declared schema."),
          ),
        );
        const listed = yield* listDetails();
        yield* guardEpoch(operation, listed, safe);
        const detail = sessionDetail(listed, safe.tabId);
        if (!detail) {
          // Idempotent within the current epoch; a stale epoch already failed.
          yield* postChecks(operation, scope.context, metadata, signal);
          return {
            outcome: "already-closed",
            serverEpoch: listed.serverEpoch,
            revision: listed.revision,
          } satisfies BrowserSessionCloseResult;
        }
        yield* dependencies.preview
          .close({ threadId, tabId: safe.tabId })
          .pipe(Effect.mapError(operationError(operation)));
        yield* postChecks(operation, scope.context, metadata, signal);
        const after = yield* listDetails();
        return {
          outcome: "closed",
          serverEpoch: after.serverEpoch,
          revision: after.revision,
        } satisfies BrowserSessionCloseResult;
      }

      type GuardInput = {
        readonly tabId: string;
        readonly serverEpoch: string;
        readonly expectedEngineGeneration: string | null;
      };

      /** Epoch, existence and generation, in that order, before any dispatch. */
      const guardedDetail = Effect.fn("BrowserSessions.guardedDetail")(function* (
        guardInput: GuardInput,
      ) {
        const listed = yield* listDetails();
        yield* guardEpoch(operation, listed, guardInput);
        const detail = sessionDetail(listed, guardInput.tabId);
        if (!detail) {
          return yield* named(
            operation,
            "BrowserSessionNotFound",
            `session '${guardInput.tabId}' does not exist on this thread.`,
          );
        }
        yield* guardGeneration(operation, detail, guardInput.expectedEngineGeneration);
        return { listed, detail };
      });

      const command = Effect.fn("BrowserSessions.command")(function* (
        guardInput: GuardInput,
        dispatch: (guarded: {
          readonly listed: PreviewManager.PreviewListDetailsResult;
          readonly detail: PreviewManager.PreviewSessionDetail;
        }) => Effect.Effect<BrowserSessionReceipt["outcome"], ExtensionOperationError>,
      ) {
        const guarded = yield* guardedDetail(guardInput);
        const outcome = yield* dispatch(guarded);
        yield* postChecks(operation, scope.context, metadata, signal);
        const after = yield* listDetails();
        const detail = sessionDetail(after, guardInput.tabId);
        if (!detail) {
          return yield* named(
            operation,
            "BrowserSessionNotFound",
            `session '${guardInput.tabId}' was removed while the command ran.`,
          );
        }
        return {
          commandId: NodeCrypto.randomUUID(),
          outcome,
          serverEpoch: after.serverEpoch,
          revision: after.revision,
          session: project(detail),
        } satisfies BrowserSessionReceipt;
      });

      const metadataWrite = (write: Effect.Effect<unknown, ExtensionOperationError>) => () =>
        Effect.as(write, "accepted" as const);

      type Guarded = {
        readonly listed: PreviewManager.PreviewListDetailsResult;
        readonly detail: PreviewManager.PreviewSessionDetail;
      };

      const desktopRequired = () =>
        named(
          operation,
          "BrowserSessionCommandUnsupported",
          `'${method}' requires an authenticated desktop engine host; none renders this session (desktop-required).`,
        );

      /** Sends one command to the owning host; the ack wait is bounded by the host registry. */
      const dispatchEngine = (
        engineCommand: BrowserEngineCommand,
        { listed, detail }: Guarded,
        engine: PreviewManager.PreviewSessionEngine,
      ) =>
        dependencies.engineHosts.dispatch({
          hostConnectionId: engine.hostConnectionId,
          target: {
            threadId,
            tabId: detail.snapshot.tabId,
            serverEpoch: listed.serverEpoch,
          },
          engineGeneration: engine.generation,
          command: engineCommand,
        });

      /**
       * Page verbs go to the host that owns the guest. The receipt reflects the
       * host's answer: applied → accepted, rejected → rejected, disconnect or
       * silence → unknown (the caller reconciles before retrying).
       */
      const engineWrite = (engineCommand: BrowserEngineCommand) => (guarded: Guarded) =>
        Effect.gen(function* () {
          const engine = guarded.detail.engine;
          if (engine === null) return yield* desktopRequired();
          const dispatched = yield* dispatchEngine(engineCommand, guarded, engine);
          return dispatched.outcome === "applied" ? "accepted" : dispatched.outcome;
        });

      /**
       * DevTools acts only on sessions this installation opened: a native
       * session or another installation's is refused (not-owned) before any
       * host is asked. Then each refusal is named: no desktop host at all
       * (desktop-required), a host that has not attached this session
       * (no-attached-engine), and a host that cannot open DevTools
       * (engine-unsupported). Other outcomes map like every page verb.
       */
      const devToolsWrite = (open: boolean) => (guarded: Guarded) =>
        Effect.gen(function* () {
          const owner = guarded.detail.extensionOwner;
          if (owner !== metadata.callerId) {
            return yield* named(
              operation,
              "BrowserSessionNotOwned",
              owner === null
                ? "the session was opened natively, not by this installation (not-owned)."
                : "the session was opened by another installation (not-owned).",
            );
          }
          const engine = guarded.detail.engine;
          if (engine === null) {
            if (!(yield* dependencies.engineHosts.hasHost)) return yield* desktopRequired();
            return yield* named(
              operation,
              "BrowserSessionEngineDetached",
              "no desktop engine has attached this session yet (no-attached-engine).",
            );
          }
          const dispatched = yield* dispatchEngine(
            { _tag: "setDevToolsOpen", open },
            guarded,
            engine,
          );
          if (dispatched.outcome === "rejected" && dispatched.reason === "not-applicable") {
            return yield* named(
              operation,
              "BrowserSessionCommandUnsupported",
              "the attached browser engine cannot open DevTools (engine-unsupported).",
            );
          }
          return dispatched.outcome === "applied" ? "accepted" : dispatched.outcome;
        });

      const decodeGuard = <A, E>(
        decoder: (value: unknown) => Effect.Effect<A, E>,
        detail: string,
      ) =>
        decoder(input).pipe(
          Effect.mapError(() => named(operation, "BrowserSessionInputError", detail)),
        );

      const lookupRemoved = () =>
        Effect.fail(
          named(operation, "BrowserSessionNotFound", "the session was removed before dispatch."),
        );

      switch (method) {
        case "navigate": {
          const safe = yield* decodeGuard(
            decodeNavigateInput,
            "navigate input fails the declared schema.",
          );
          return yield* command(safe, (guarded) =>
            Effect.gen(function* () {
              const recorded = yield* dependencies.preview
                .navigate({ threadId, tabId: safe.tabId, url: safe.url })
                .pipe(
                  Effect.catchTag("PreviewSessionLookupError", lookupRemoved),
                  Effect.mapError(operationError(operation)),
                );
              // With no owning host (web, mobile, remote-only) the request stays
              // recorded metadata; an owner loads the recorded URL and its next
              // fenced report settles the pending navigation.
              if (guarded.detail.engine === null || recorded.navStatus._tag === "Idle") {
                return "accepted" as const;
              }
              return yield* engineWrite({ _tag: "navigate", url: recorded.navStatus.url })(guarded);
            }),
          );
        }
        case "back":
        case "forward":
        case "reload":
        case "hardReload": {
          const safe = yield* decodeGuard(
            decodeGuardInput,
            "command input fails the declared schema.",
          );
          return yield* command(safe, engineWrite({ _tag: method }));
        }
        case "zoom": {
          const safe = yield* decodeGuard(decodeZoomInput, "zoom input fails the declared schema.");
          return yield* command(safe, engineWrite({ _tag: "zoom", zoomFactor: safe.zoomFactor }));
        }
        case "setAppearance": {
          const safe = yield* decodeGuard(
            decodeAppearanceInput,
            "setAppearance input fails the declared schema.",
          );
          return yield* command(
            safe,
            engineWrite({ _tag: "setAppearance", appearance: safe.appearance }),
          );
        }
        case "setAudioMuted": {
          const safe = yield* decodeGuard(
            decodeMutedInput,
            "setAudioMuted input fails the declared schema.",
          );
          return yield* command(safe, engineWrite({ _tag: "setAudioMuted", muted: safe.muted }));
        }
        case "openDevTools":
        case "closeDevTools": {
          const safe = yield* decodeGuard(
            decodeGuardInput,
            `${method} input fails the declared schema.`,
          );
          return yield* command(safe, devToolsWrite(method === "openDevTools"));
        }
        case "setPictureInPicture": {
          const safe = yield* decodeGuard(
            decodePictureInPictureInput,
            "setPictureInPicture input fails the declared schema.",
          );
          return yield* command(safe, (guarded) =>
            Effect.gen(function* () {
              const engine = projectEngine(guarded.detail.engine);
              if (engine.state === "recovering" || engine.state === "crashed") {
                const reason =
                  engine.state === "recovering" ? "recovering" : (engine.reason ?? "crash");
                return yield* named(
                  operation,
                  "BrowserSessionEngineNotLive",
                  `picture-in-picture needs a live page; the engine is ${engine.state} (${reason}).`,
                );
              }
              return yield* engineWrite({ _tag: "setPictureInPicture", open: safe.open })(guarded);
            }),
          );
        }
        case "resize": {
          const safe = yield* decodeGuard(
            decodeResizeInput,
            "resize input fails the declared schema or viewport bounds.",
          );
          return yield* command(
            safe,
            metadataWrite(
              dependencies.preview
                .resize({ threadId, tabId: safe.tabId, viewport: safe.viewport })
                .pipe(
                  Effect.catchTag("PreviewSessionLookupError", lookupRemoved),
                  Effect.mapError(operationError(operation)),
                ),
            ),
          );
        }
        default:
          return yield* failure(operation, "Browser sessions method is unavailable.");
      }
    });

  const subscribe = (
    name: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
    resumeCursor?: string,
  ): AsyncIterable<ApiStreamEvent> => {
    const operation = `${OPERATION}.events`;
    if (name !== "events") {
      throw failure(operation, "Browser sessions stream is unavailable.");
    }
    if (resumeCursor !== undefined) {
      throw failure(operation, "Browser sessions stream does not support resume cursors.");
    }
    try {
      decodeEventsInput(input);
    } catch {
      throw failure(operation, "Invalid browser sessions events request.");
    }
    if (!authorized(metadata.principal, false) || !metadata.assertAuthority) {
      throw failure(operation, "Browser sessions authority is unavailable.");
    }
    const assertAuthority = metadata.assertAuthority;
    const threadIdRaw = context.resource.threadId;
    if (!threadIdRaw) {
      throw failure(operation, "Browser sessions require a thread-scoped context.");
    }

    const queue: QueuedValue[] = [];
    let queuedBytes = 0;
    let finished = false;
    let wake: (() => void) | null = null;
    let scopeContext: ViewContext | null = null;
    let closeManagerScope: (() => Promise<void>) | null = null;
    let setup: Promise<void> | null = null;
    const teardownController = new AbortController();
    const pumpController = new AbortController();
    const runSignal = AbortSignal.any([signal, teardownController.signal]);
    const pumpSignal = AbortSignal.any([runSignal, pumpController.signal]);

    const terminate = (
      reason: Extract<BrowserSessionStreamValue, { kind: "closed" }>["reason"],
    ) => {
      queue.length = 0;
      queuedBytes = 0;
      queue.push({
        bytes: 0,
        make: () =>
          Promise.resolve({
            type: "closed",
            value: { kind: "closed", reason },
          }),
      });
      finished = true;
      // Only the pump is aborted — the delivery signal stays live so the
      // terminal closed event still reaches the caller.
      pumpController.abort();
      wake?.();
      wake = null;
    };

    /** Queue accounting applies to projected values, never to native frames. */
    const enqueue = (entry: QueuedValue) => {
      if (finished || runSignal.aborted) return;
      if (queue.length >= MAX_QUEUED_EVENTS || queuedBytes + entry.bytes > MAX_QUEUED_BYTES) {
        terminate("overflow");
        return;
      }
      queue.push(entry);
      queuedBytes += entry.bytes;
      wake?.();
      wake = null;
    };

    const tombstones = new Set<string>();
    let scopeDead = false;
    let boundary: { readonly serverEpoch: string; readonly revision: number } | null = null;
    let project = projectorFor(undefined);

    const onInternalEvent = (item: PreviewManager.PreviewInternalEvent) => {
      if (finished || runSignal.aborted) return;
      const event = item.event;
      if (!boundary) return;
      if (event.serverEpoch !== boundary.serverEpoch) {
        terminate("epoch-changed");
        return;
      }
      // Events at or below the snapshot boundary are already represented by
      // the snapshot; replaying them would double-deliver.
      if (event.revision <= boundary.revision) return;
      if (event.threadId !== threadIdRaw) return;
      if (event.type === "closed") {
        tombstones.add(event.tabId);
        // Bound the entry with the longest removal reason's encoded size.
        const bytes = sessionBytes({
          type: "data",
          value: {
            kind: "session-removed",
            revision: event.revision,
            tabId: event.tabId,
            reason: "thread-deleted",
          },
        });
        enqueue({
          bytes,
          removal: true,
          make: async () => {
            // user-closed vs thread-deleted resolves against authoritative
            // thread state at delivery — the native close carries no reason.
            // A repository error cannot prove deletion, so it stays user-closed.
            const thread = await Effect.runPromise(
              dependencies.threads.getById({ threadId: ThreadId.make(threadIdRaw) }),
            ).catch(() => null);
            const deleted =
              thread === null ? false : Option.isNone(thread) || thread.value.deletedAt !== null;
            return {
              type: "data",
              value: {
                kind: "session-removed",
                revision: event.revision,
                tabId: event.tabId,
                reason: deleted ? "thread-deleted" : "user-closed",
              } satisfies BrowserSessionStreamValue,
            };
          },
        });
        return;
      }
      if (item.detail === null || tombstones.has(event.tabId)) return;
      const session = project(item.detail);
      const value: ApiStreamEvent = {
        type: "data",
        value: {
          kind: "session-upsert",
          revision: event.revision,
          session,
        } satisfies BrowserSessionStreamValue,
      };
      enqueue({ bytes: sessionBytes(value), make: () => Promise.resolve(value) });
    };

    const iterable: AsyncIterable<ApiStreamEvent> = {
      [Symbol.asyncIterator]() {
        let returned = false;
        const failIfAborted = () => {
          if (runSignal.aborted) throw runSignal.reason ?? failure(operation, "Stream cancelled.");
        };
        const teardown = async () => {
          finished = true;
          pumpController.abort();
          teardownController.abort();
          await closeManagerScope?.();
        };
        return {
          async next() {
            if (returned) return { done: true, value: undefined };
            try {
              failIfAborted();
              setup ??= (async () => {
                const scope = await Effect.runPromise(resolve(context), { signal: runSignal });
                scopeContext = scope.context;
                project = projectorFor(scope.context.resource.projectId);
                await assertAuthority();
                failIfAborted();
                // Subscribe BEFORE reading the snapshot so no event lands
                // between the boundary and the live stream.
                const managerScope = await Effect.runPromise(Scope.make(), {
                  signal: runSignal,
                });
                closeManagerScope = () =>
                  Effect.runPromise(Scope.close(managerScope, Exit.void)).catch(() => {});
                const subscription = await Effect.runPromise(
                  dependencies.preview.subscribeDetails.pipe(
                    Effect.provideService(Scope.Scope, managerScope),
                  ),
                  { signal: runSignal },
                );
                const listed = await Effect.runPromise(
                  dependencies.preview.listDetails({ threadId: ThreadId.make(threadIdRaw) }),
                  { signal: runSignal },
                );
                if (listed.sessions.length > BROWSER_SESSION_LIMIT) {
                  throw named(
                    operation,
                    "BrowserSessionLimitExceeded",
                    `thread holds ${listed.sessions.length} sessions; the limit is ${BROWSER_SESSION_LIMIT}.`,
                  );
                }
                const sessions = listed.sessions.map(project);
                if (
                  sessionBytes({
                    serverEpoch: listed.serverEpoch,
                    revision: listed.revision,
                    sessions,
                  }) > MAX_SNAPSHOT_BYTES
                ) {
                  throw named(
                    operation,
                    "BrowserSessionLimitExceeded",
                    "the complete session snapshot exceeds 512 KiB.",
                  );
                }
                boundary = {
                  serverEpoch: listed.serverEpoch,
                  revision: listed.revision,
                };
                const snapshotId = NodeCrypto.randomUUID();
                // Prepare every chunk before publishing any — a partial
                // snapshot must never reach the caller.
                const chunks: BrowserSession[][] = [];
                let current: BrowserSession[] = [];
                const frameBytes = (sessionsChunk: BrowserSession[]) =>
                  sessionBytes({
                    streamId: "x".repeat(128),
                    sequence: Number.MAX_SAFE_INTEGER,
                    type: "data",
                    value: {
                      kind: "snapshot-chunk",
                      snapshotId,
                      chunkIndex: Number.MAX_SAFE_INTEGER,
                      sessions: sessionsChunk,
                    },
                  });
                for (const session of sessions) {
                  if (current.length > 0 && frameBytes([...current, session]) >= MAX_FRAME_BYTES) {
                    chunks.push(current);
                    current = [];
                  }
                  current.push(session);
                  if (frameBytes(current) >= MAX_FRAME_BYTES) {
                    throw named(
                      operation,
                      "BrowserSessionLimitExceeded",
                      "a single session exceeds the 64 KiB frame bound.",
                    );
                  }
                }
                if (current.length > 0) chunks.push(current);
                // Queue accounting charges each emitted envelope once —
                // start/complete carry snapshot metadata only, so the
                // session bytes live exclusively in the chunk frames.
                const startEvent: ApiStreamEvent = {
                  type: "snapshot",
                  value: {
                    kind: "snapshot-start",
                    snapshotId,
                    serverEpoch: listed.serverEpoch,
                    revision: listed.revision,
                    sessionCount: sessions.length,
                  } satisfies BrowserSessionStreamValue,
                };
                enqueue({
                  bytes: sessionBytes(startEvent),
                  make: () => Promise.resolve(startEvent),
                });
                chunks.forEach((sessionsChunk, chunkIndex) => {
                  const chunkEvent: ApiStreamEvent = {
                    type: "data",
                    value: {
                      kind: "snapshot-chunk",
                      snapshotId,
                      chunkIndex,
                      sessions: sessionsChunk,
                    } satisfies BrowserSessionStreamValue,
                  };
                  enqueue({
                    bytes: sessionBytes(chunkEvent),
                    make: () => Promise.resolve(chunkEvent),
                  });
                });
                const completeEvent: ApiStreamEvent = {
                  type: "data",
                  value: {
                    kind: "snapshot-complete",
                    snapshotId,
                    serverEpoch: listed.serverEpoch,
                    revision: listed.revision,
                    sessionCount: sessions.length,
                  } satisfies BrowserSessionStreamValue,
                };
                enqueue({
                  bytes: sessionBytes(completeEvent),
                  make: () => Promise.resolve(completeEvent),
                });
                // The pump drains the subscription until the stream ends;
                // a rejected take after scope close means the source is gone.
                void (async () => {
                  for (;;) {
                    const item = await Effect.runPromise(PubSub.take(subscription), {
                      signal: pumpSignal,
                    });
                    onInternalEvent(item);
                  }
                })().catch(() => {
                  if (!finished && !runSignal.aborted) terminate("source-unavailable");
                });
              })();
              await setup;
              failIfAborted();
              const scopeClosed = (): ApiStreamEvent => ({
                type: "closed",
                value: { kind: "closed", reason: "scope-invalidated" },
              });
              if (scopeDead && queue.length === 0) {
                await teardown();
                returned = true;
                return { done: false, value: scopeClosed() };
              }
              // eslint-disable-next-line no-unmodified-loop-condition -- producer and terminate callbacks wake this waiter.
              while (queue.length === 0 && !finished) {
                await new Promise<void>((resolveWait) => {
                  wake = resolveWait;
                });
                failIfAborted();
              }
              const entry = queue.shift();
              if (!entry) {
                await teardown();
                returned = true;
                return { done: true, value: undefined };
              }
              queuedBytes -= entry.bytes;
              // Authority is revalidated for every delivered value, not just
              // at stream open — a revoked caller receives no more data.
              await assertAuthority();
              if (!scopeDead && scopeContext) {
                try {
                  await Effect.runPromise(resolve(scopeContext), { signal: runSignal });
                } catch {
                  // Scope death is terminal but not instant: queued removals
                  // still report their honest reason (thread-deleted) before
                  // the stream closes scope-invalidated.
                  scopeDead = true;
                }
              }
              if (scopeDead && !entry.removal) {
                await teardown();
                returned = true;
                return { done: false, value: scopeClosed() };
              }
              const event = await entry.make();
              failIfAborted();
              if (event.type === "closed") {
                await teardown();
                returned = true;
              }
              return { done: false, value: event };
            } catch (error) {
              await teardown();
              returned = true;
              throw error;
            }
          },
          async return() {
            returned = true;
            await teardown();
            return { done: true, value: undefined };
          },
        };
      },
    };
    return iterable;
  };

  return {
    providerId: "t3.host-browser-sessions",
    definition: browserSessionsApi.definition,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(invoke(method, input, context, signal, metadata), { signal }),
    subscribe,
  };
}

export const makeBrowserSessionsApiProvider = Effect.fn("BrowserSessionsApi.make")(
  function* (input: { readonly favicons: BrowserFaviconAssets }) {
    const environment = yield* ServerEnvironment;
    return createBrowserSessionsApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      preview: yield* PreviewManager.PreviewManager,
      engineHosts: yield* BrowserEngineHosts.BrowserEngineHosts,
      favicons: input.favicons,
    });
  },
);
