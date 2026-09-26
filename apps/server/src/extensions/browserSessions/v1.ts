/**
 * `t3.browser/sessions@1.0.0` — public browser-session metadata capability.
 *
 * This adapter is metadata-only: it projects the server's native
 * `PreviewManager` state through the public contract and never exposes
 * webview handles, partitions, preload URLs, evaluation endpoints, or
 * presentation slots. Command receipts record metadata acceptance, never
 * engine execution — navigation honesty is enforced by comparing the
 * dispatch-side request revision against the engine-side `reportStatus`
 * revision carried by `PreviewSessionDetail` (see `Manager.ts`).
 */
import {
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
  BROWSER_SESSION_LIMIT,
  BROWSER_SESSION_ZOOM_LEVELS,
  browserSessionsApi,
  type BrowserSession,
  type BrowserSessionCapabilities,
  type BrowserSessionCloseResult,
  type BrowserSessionEngine,
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
import * as PreviewManager from "../../preview/Manager.ts";
import { makeExtensionScopeResolver } from "../scope.ts";

const OPERATION = "browser.sessions";
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_QUEUED_EVENTS = 128;
const MAX_QUEUED_BYTES = 512 * 1024;
const WRITE_METHODS = new Set(["open", "navigate", "close", ...BROWSER_SESSION_COMMANDS]);

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const isOperationError = Schema.is(ExtensionOperationError);
/** Named denials keep a stable prefix so callers can branch on the name. */
const named = (operation: string, name: string, detail: string) =>
  failure(operation, `${name}: ${detail}`);

/** Native `_tag`s stay visible; only untagged causes collapse to a message. */
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

/**
 * No authenticated engine-host registration exists yet, so the only honest
 * engine state is unavailable.
 * Generation is null rather than fabricated.
 */
const engineUnavailable = (): BrowserSessionEngine => ({
  state: "unavailable",
  generation: null,
  reason: "desktop-required",
});

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
const decodeResizeInput = closedDecoder({
  ...CommandGuardFields,
  viewport: PreviewViewportSetting,
});
const EmptyInput = Schema.Record(Schema.String, Schema.Never);
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
  const nav = snapshot.navStatus;
  if (nav._tag === "Idle") return { kind: "idle", url: null, title: "" };
  const engineAuthored =
    navigation.engineRevision !== null &&
    (navigation.requestRevision === null ||
      navigation.engineRevision >= navigation.requestRevision);
  if (!engineAuthored) {
    // Dispatch wrote navStatus before any engine report — the only honest
    // kind is "pending"; navStatus Success here is NOT proof of load.
    return {
      kind: "pending",
      url: navigation.requestedUrl ?? nav.url,
      title: nav.title,
    };
  }
  switch (nav._tag) {
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

const projectSession = (detail: PreviewManager.PreviewSessionDetail): BrowserSession => ({
  tabId: detail.snapshot.tabId,
  requestedUrl: detail.navigation.requestedUrl,
  navigation: projectNavigation(detail),
  canGoBack: detail.snapshot.canGoBack,
  canGoForward: detail.snapshot.canGoForward,
  viewport: (detail.snapshot.viewport ?? { _tag: "fill" }) as BrowserSessionViewport,
  ...(detail.snapshot.profileId === undefined ? {} : { profileId: detail.snapshot.profileId }),
  engine: engineUnavailable(),
  // Desktop overlay fields live in the renderer and are null here — never
  // fabricated defaults.
  zoomFactor: null,
  appearance: null,
  audioMuted: null,
  audible: null,
});

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
      "open" | "navigate" | "resize" | "refresh" | "close" | "listDetails" | "subscribeDetails"
    >;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);

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

  const guard = Effect.fn("BrowserSessions.guard")(function* (
    operation: string,
    listed: PreviewManager.PreviewListDetailsResult,
    input: { readonly serverEpoch: string; readonly expectedEngineGeneration?: string | null },
  ) {
    if (input.serverEpoch !== listed.serverEpoch) {
      return yield* named(
        operation,
        "BrowserStaleServerEpoch",
        "the request epoch does not match the live session epoch.",
      );
    }
    if (input.expectedEngineGeneration !== undefined && input.expectedEngineGeneration !== null) {
      return yield* named(
        operation,
        "BrowserStaleEngineGeneration",
        "the expected engine generation cannot match: no authenticated engine is attached.",
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
        yield* postChecks(operation, scope.context, metadata, signal);
        return {
          metadata: { supported: true },
          // Presentation requires an attached engine on a desktop host —
          // a named deferral, not a capability this slice claims.
          presentation: { supported: false, reason: "desktop-required" },
          // Discovery lists only commands with real dispatch today.
          // back/forward/reload/hardReload/zoom/setAppearance/setAudioMuted
          // stay in the contract but fail by name until an authenticated
          // host dispatch and engine attachment exist.
          commands: ["resize"],
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
        const sessions = listed.sessions.map(projectSession);
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

      if (method === "open") {
        const safe = yield* decodeOpenInput(input).pipe(
          Effect.mapError(() =>
            named(operation, "BrowserSessionInputError", "open input fails the declared schema."),
          ),
        );
        const before = yield* listDetails();
        if (before.sessions.length >= BROWSER_SESSION_LIMIT) {
          return yield* named(
            operation,
            "BrowserSessionLimitExceeded",
            `thread already holds ${BROWSER_SESSION_LIMIT} sessions.`,
          );
        }
        const snapshot = yield* dependencies.preview
          .open({
            threadId,
            ...(safe.url === undefined ? {} : { url: safe.url }),
            ...(safe.viewport === undefined ? {} : { viewport: safe.viewport }),
            ...(safe.profileId === undefined ? {} : { profileId: safe.profileId }),
          })
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
          session: projectSession(detail),
        } satisfies BrowserSessionReceipt;
      }

      if (method === "close") {
        const safe = yield* decodeCloseInput(input).pipe(
          Effect.mapError(() =>
            named(operation, "BrowserSessionInputError", "close input fails the declared schema."),
          ),
        );
        const listed = yield* listDetails();
        yield* guard(operation, listed, safe);
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

      const command = Effect.fn("BrowserSessions.command")(function* (
        guardInput: {
          readonly tabId: string;
          readonly serverEpoch: string;
          readonly expectedEngineGeneration: string | null;
        },
        dispatch: Effect.Effect<unknown, ExtensionOperationError>,
      ) {
        const listed = yield* listDetails();
        yield* guard(operation, listed, guardInput);
        if (!sessionDetail(listed, guardInput.tabId)) {
          return yield* named(
            operation,
            "BrowserSessionNotFound",
            `session '${guardInput.tabId}' does not exist on this thread.`,
          );
        }
        yield* dispatch;
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
          outcome: "accepted",
          serverEpoch: after.serverEpoch,
          revision: after.revision,
          session: projectSession(detail),
        } satisfies BrowserSessionReceipt;
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
          return yield* command(
            safe,
            dependencies.preview
              .navigate({ threadId, tabId: safe.tabId, url: safe.url })
              .pipe(
                Effect.catchTag("PreviewSessionLookupError", lookupRemoved),
                Effect.mapError(operationError(operation)),
              ),
          );
        }
        // These verbs have no engine dispatch in this slice:
        // back/forward/zoom/setAppearance/setAudioMuted have no server-side
        // path at all, and PreviewManager.refresh is an existence check that
        // emits nothing — a metadata "accepted" for it would be a false
        // proof of reload. Every one fails by name until an
        // authenticated host dispatch exists; verb-specific fields still
        // validate so malformed input is rejected by the contract schema.
        case "back":
        case "forward": {
          yield* decodeGuard(decodeGuardInput, "command input fails the declared schema.");
          return yield* named(
            operation,
            "BrowserSessionCommandUnsupported",
            `'${method}' requires an authenticated engine host that does not exist in this slice.`,
          );
        }
        case "zoom": {
          yield* decodeGuard(decodeZoomInput, "zoom input fails the declared schema.");
          return yield* named(
            operation,
            "BrowserSessionCommandUnsupported",
            "'zoom' requires an authenticated engine host that does not exist in this slice.",
          );
        }
        case "setAppearance": {
          yield* decodeGuard(
            decodeAppearanceInput,
            "setAppearance input fails the declared schema.",
          );
          return yield* named(
            operation,
            "BrowserSessionCommandUnsupported",
            "'setAppearance' requires an authenticated engine host that does not exist in this slice.",
          );
        }
        case "setAudioMuted": {
          yield* decodeGuard(decodeMutedInput, "setAudioMuted input fails the declared schema.");
          return yield* named(
            operation,
            "BrowserSessionCommandUnsupported",
            "'setAudioMuted' requires an authenticated engine host that does not exist in this slice.",
          );
        }
        case "reload": {
          yield* decodeGuard(decodeGuardInput, "command input fails the declared schema.");
          return yield* named(
            operation,
            "BrowserSessionCommandUnsupported",
            "'reload' has no engine dispatch — PreviewManager.refresh is an existence check, not a reload.",
          );
        }
        case "hardReload": {
          yield* decodeGuard(decodeGuardInput, "command input fails the declared schema.");
          return yield* named(
            operation,
            "BrowserSessionCommandUnsupported",
            "'hardReload' is separately unsupported: no host-side hard/soft distinction exists to honor it.",
          );
        }
        case "resize": {
          const safe = yield* decodeGuard(
            decodeResizeInput,
            "resize input fails the declared schema or viewport bounds.",
          );
          return yield* command(
            safe,
            dependencies.preview
              .resize({ threadId, tabId: safe.tabId, viewport: safe.viewport })
              .pipe(
                Effect.catchTag("PreviewSessionLookupError", lookupRemoved),
                Effect.mapError(operationError(operation)),
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
      const session = projectSession(item.detail);
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
                const sessions = listed.sessions.map(projectSession);
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

export const makeBrowserSessionsApiProvider = Effect.fn("BrowserSessionsApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createBrowserSessionsApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    preview: yield* PreviewManager.PreviewManager,
  });
});
