import * as NodeCrypto from "node:crypto";
import {
  ClientProvidersError,
  ExtensionViewContext,
  type ClientProviderCaller,
} from "@t3tools/contracts";
import {
  browserHistoryApi,
  UI_KEYBINDINGS_API,
  UI_KEYBINDINGS_GLOBAL,
  UI_NOTIFICATIONS_API,
  UI_PANELS_API,
  UI_PREFERENCES_API,
  UI_THEME_API,
  checkExternalUrl,
  isWorkspaceFilePath,
  UI_EXTERNAL_API,
  UI_EDITOR_API,
  UI_NAVIGATION_API,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import {
  CLIENT_EXTERNAL_V11_RANGE,
  CLIENT_PANELS_V11_RANGE,
  CLIENT_EDITOR_V11_RANGE,
  CLIENT_NAVIGATION_V11_RANGE,
  CLIENT_NAVIGATION_V12_RANGE,
  CLIENT_NOTIFICATIONS_V11_RANGE,
  CLIENT_PREFERENCES_V11_RANGE,
  CLIENT_PREFERENCES_V12_RANGE,
} from "@t3tools/extension-sdk/clientProviders";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ClientApiProviders } from "./ClientApiProviders.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
/** Notification outcomes stay resolvable by `awaitAction` for one minute. */
const OUTCOME_RETENTION_MS = 60_000;
const OUTCOME_RETENTION_CAP = 256;
/** `keepOpen` clicks queued for the next `awaitAction`; older clicks drop first. */
const PENDING_CLICKS_CAP = 8;

/**
 * The public `t3.ui/*` contracts backed by `t3.client/*` client providers.
 * Each adapter resolves an explicit connection target, stamps the
 * broker-verified caller identity into the frame, and forwards the op over
 * the connect stream. There is no failover: an unresolved or vanished target
 * fails `client-provider-unavailable`/`client-target-*` instead of landing
 * on a sibling connection.
 */

export interface UiClientBridgeDeps {
  readonly environmentId: string;
  readonly clientApiProviders: ClientApiProviders["Service"];
  /**
   * Late-bound grant check — looks the installation up in the extension
   * runtime and runs the same `authorize` the broker uses. Needed for
   * `t3.ui/keybindings.global`, an op-level grant the broker's per-method
   * `requiredGrants` cannot express.
   */
  readonly authorizeGrant: (
    installationId: string,
    grant: string,
    context: ViewContext,
  ) => Promise<boolean>;
  /**
   * The project owning a live thread in this environment, or null for an
   * unknown or deleted thread. `t3.ui/navigation` scopes its target by it.
   */
  readonly resolveThreadProject: (threadId: string) => Promise<string | null>;
  /**
   * The agent roster of a live thread (the same `projectAgents` fold
   * `t3.orchestration/status` publishes), or null for an unknown or deleted
   * thread. `openAgentSession` resolves session URLs from it so a pack never
   * supplies one.
   */
  readonly readThreadAgentSessions: (
    threadId: string,
  ) => Promise<readonly { readonly id: string; readonly sessionUrl?: string }[] | null>;
}

const providerError = (code: string, detail: string) =>
  new ClientProvidersError({ code, detail: detail.slice(0, 2000) });

const decodeContext = Schema.decodeUnknownSync(ExtensionViewContext);

/** The broker-verified immediate caller, minted into the client frame. */
const callerOf = (metadata: HostApiInvocationMetadata): ClientProviderCaller => {
  const generation = metadata.callerGenerations.at(-1);
  if (!generation) throw providerError("client-target-denied", "The caller is unidentified.");
  return {
    installationId: generation.pluginId,
    contentHash: generation.contentHash,
    installationGeneration: generation.installationGeneration,
  };
};

/**
 * Resolves the frame target: the verified `self` hint for environment-session
 * principals, or an explicit `connection` for host principals. Provider
 * sessions never reach a client in V1.
 */
export const resolveConnectionId = (
  deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
  metadata: HostApiInvocationMetadata,
): Effect.Effect<string, ClientProvidersError> =>
  deps.clientApiProviders.resolveTarget(
    deps.environmentId,
    metadata.principal,
    metadata.clientConnectionId,
  );

const targetField = (metadata: HostApiInvocationMetadata, connectionId: string) =>
  metadata.principal?.kind === "environment-session"
    ? ({ kind: "self" } as const)
    : ({ kind: "connection", connectionId } as const);

/** Resolve + forward one unary op. `input` is the op payload minus `target`. */
export const invokeClient = (
  deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
  request: {
    readonly apiId: string;
    readonly method: string;
    readonly input: Json;
    readonly context: ViewContext;
    readonly metadata: HostApiInvocationMetadata;
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
    /** Pre-resolved target — skips re-resolution so related frames share one connection. */
    readonly connectionId?: string;
  },
): Effect.Effect<Json, ClientProvidersError> =>
  Effect.gen(function* () {
    const connectionId =
      request.connectionId ?? (yield* resolveConnectionId(deps, request.metadata));
    return yield* deps.clientApiProviders.invoke({
      connectionId,
      apiId: request.apiId,
      method: request.method,
      input: {
        target: targetField(request.metadata, connectionId),
        ...(typeof request.input === "object" && request.input !== null ? request.input : {}),
      } as Json,
      context: yield* Effect.try({
        try: () => decodeContext(request.context),
        catch: () => providerError("client-target-denied", "Invocation context is malformed."),
      }),
      caller: callerOf(request.metadata),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      signal: request.signal,
    });
  });

const openClientStream = (
  deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
  request: {
    readonly apiId: string;
    readonly name: string;
    readonly input: Json;
    readonly context: ViewContext;
    readonly metadata: HostApiInvocationMetadata;
    readonly coalesce?: boolean;
    /** Pre-resolved target, as in `invokeClient`. */
    readonly connectionId?: string;
  },
): Effect.Effect<
  { readonly events: AsyncIterable<ApiStreamEvent>; readonly close: () => Effect.Effect<void> },
  ClientProvidersError
> =>
  Effect.gen(function* () {
    const connectionId =
      request.connectionId ?? (yield* resolveConnectionId(deps, request.metadata));
    return yield* deps.clientApiProviders.openSubscription({
      connectionId,
      apiId: request.apiId,
      name: request.name,
      input: {
        target: targetField(request.metadata, connectionId),
        ...(typeof request.input === "object" && request.input !== null ? request.input : {}),
      } as Json,
      context: yield* Effect.try({
        try: () => decodeContext(request.context),
        catch: () => providerError("client-target-denied", "Invocation context is malformed."),
      }),
      caller: callerOf(request.metadata),
      ...(request.coalesce !== undefined ? { coalesce: request.coalesce } : {}),
    });
  });

/**
 * The stream provider returns an async iterable; opening lazily on first pull
 * keeps resolution failures inside the broker's stream lifecycle.
 */
const streamThrough = (
  deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
  request: {
    readonly apiId: string;
    readonly clientName: string;
    readonly input: Json;
    readonly context: ViewContext;
    readonly signal: AbortSignal;
    readonly metadata: HostApiInvocationMetadata;
    readonly coalesce?: boolean;
    /** Resolves the target (and the input for it) before the stream opens. */
    readonly prepare?: () => Promise<{ readonly connectionId: string; readonly input: Json }>;
  },
): AsyncIterable<ApiStreamEvent> =>
  (async function* () {
    const prepared = await request.prepare?.();
    const subscription = await Effect.runPromise(
      openClientStream(deps, {
        apiId: request.apiId,
        name: request.clientName,
        input: prepared?.input ?? request.input,
        context: request.context,
        metadata: request.metadata,
        ...(request.coalesce !== undefined ? { coalesce: request.coalesce } : {}),
        ...(prepared ? { connectionId: prepared.connectionId } : {}),
      }),
      { signal: request.signal },
    );
    const onAbort = () => {
      Effect.runFork(subscription.close());
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield* subscription.events;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      await Effect.runPromise(subscription.close());
    }
  })();

/** `getCapabilities`: per-op availability for the resolved area + the client directory. */
const capabilities = (
  deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
  adapter: string,
  operationAreas: Readonly<Record<string, string>>,
  metadata: HostApiInvocationMetadata,
): Promise<Json> =>
  Effect.runPromise(
    Effect.gen(function* () {
      // Provider-session callers can see the contracts but reach none of the ops.
      const reachable = metadata.principal?.kind !== "provider-session";
      const operations: Record<string, boolean> = {};
      for (const [operation, apiId] of Object.entries(operationAreas)) {
        operations[operation] =
          reachable && (yield* deps.clientApiProviders.hasProvider(deps.environmentId, apiId));
      }
      // The client directory is scoped like targeting itself: host callers see
      // every connection, environment sessions see only their own, provider
      // sessions see none — a cross-session directory would leak sibling
      // connection ids and device metadata the caller cannot legitimately use.
      const targets = yield* deps.clientApiProviders.listTargets(deps.environmentId);
      const clients: (typeof targets)[number][] = [];
      if (metadata.principal?.kind === "host") {
        clients.push(...targets);
      } else if (metadata.principal?.kind === "environment-session") {
        for (const target of targets) {
          if (
            yield* deps.clientApiProviders.connectionForSession(
              metadata.principal.id,
              target.connectionId,
            )
          )
            clients.push(target);
        }
      }
      // Named schema types lack Json's index signature; the payload is
      // contract-bounded so the cast is safe.
      return {
        adapter,
        operations,
        clients,
      } as unknown as Json;
    }),
  );

const ambient = (
  deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
  apiId: string,
): NonNullable<HostApiProvider["availability"]> => {
  return async () =>
    (await Effect.runPromise(deps.clientApiProviders.hasProvider(deps.environmentId, apiId)))
      ? { status: "ready" }
      : {
          status: "unavailable",
          reason: {
            code: "client-provider-unavailable",
            detail: "No connected client registered this provider.",
            relatedIds: [],
          },
        };
};

const forward =
  (
    deps: Pick<UiClientBridgeDeps, "environmentId" | "clientApiProviders">,
    apiId: string,
    clientMethod: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) =>
  (
    _method: string,
    input: Json,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ): Promise<Json> =>
    Effect.runPromise(
      invokeClient(deps, {
        apiId,
        method: clientMethod,
        input,
        context,
        metadata,
        signal,
        timeoutMs,
      }),
      { signal },
    );

const CLIENT_THEME = "t3.client/theme";
const CLIENT_TERMINAL_APPEARANCE = "t3.client/terminal-appearance";
const CLIENT_NOTIFICATIONS = "t3.client/notifications";
const CLIENT_KEYBINDINGS = "t3.client/keybindings";
const CLIENT_PANELS = "t3.client/panels";
const CLIENT_PREFERENCES = "t3.client/preferences";
const CLIENT_EXTERNAL = "t3.client/external";
const CLIENT_EDITOR = "t3.client/editor";
const CLIENT_BROWSER_HISTORY = "t3.client/browser-history";
const CLIENT_NAVIGATION = "t3.client/navigation";

interface NotificationOutcome {
  readonly actionId?: string;
  readonly dismissed?: true;
}
interface LiveNotification {
  readonly ownerId: string;
  /** The seam connection the toast lives on — outcomes stay connection-owned. */
  readonly connectionId: string;
  /** `keepOpen` action ids clicked while no `awaitAction` was waiting. */
  readonly clicks: string[];
  readonly waiters: {
    resolve: (outcome: NotificationOutcome) => void;
    reject: (error: unknown) => void;
  }[];
}

export function createUiClientApiProviders(deps: UiClientBridgeDeps): readonly HostApiProvider[] {
  /** Live notifications, keyed by server-minted notificationId. */
  const live = new Map<string, LiveNotification>();
  /**
   * Settled outcomes retained for 60 s so late `awaitAction` calls resolve,
   * after any `keepOpen` clicks still queued when the toast closed.
   */
  const outcomes = new Map<
    string,
    {
      outcome: NotificationOutcome;
      clicks: string[];
      expiresAt: number;
      ownerId: string;
      connectionId: string;
    }
  >();
  /** Tokens minted for fully-rejected command sets — they name no client-side registration. */
  const voidTokens = new Set<string>();

  const nowMs = () => Effect.runSync(Clock.currentTimeMillis);

  const recordOutcome = (
    notificationId: string,
    outcome: NotificationOutcome,
    ownerId: string,
    connectionId: string,
  ) => {
    const record = live.get(notificationId);
    // Settlement is idempotent: the client's outcome event and an API
    // dismiss response can both arrive, and the first keeps its queued clicks.
    if (!record && outcomes.has(notificationId)) return;
    if (record) {
      live.delete(notificationId);
      for (const waiter of record.waiters.splice(0)) waiter.resolve(outcome);
    }
    outcomes.set(notificationId, {
      outcome,
      clicks: record?.clicks ?? [],
      expiresAt: nowMs() + OUTCOME_RETENTION_MS,
      ownerId,
      connectionId,
    });
    // The retention cap is per connection — a busy client never evicts a
    // sibling connection's recent outcomes.
    const owned = [...outcomes.keys()].filter(
      (key) => outcomes.get(key)!.connectionId === connectionId,
    );
    for (const key of owned.slice(0, Math.max(0, owned.length - OUTCOME_RETENTION_CAP)))
      outcomes.delete(key);
    Effect.runFork(deps.clientApiProviders.unregisterCorrelation(notificationId));
  };

  const settleOutcome = (notificationId: string) => {
    const retained = outcomes.get(notificationId);
    if (!retained) return undefined;
    if (retained.expiresAt <= nowMs()) {
      outcomes.delete(notificationId);
      return undefined;
    }
    return retained;
  };

  const expireNotification = (notificationId: string, failure: ClientProvidersError) => {
    const record = live.get(notificationId);
    if (!record) return;
    live.delete(notificationId);
    for (const waiter of record.waiters.splice(0)) waiter.reject(failure);
  };

  const ownedNotification = (
    notificationId: string,
    metadata: HostApiInvocationMetadata,
  ): LiveNotification => {
    const record = live.get(notificationId);
    if (!record) {
      if (settleOutcome(notificationId))
        throw providerError(
          "notification-expired",
          "The notification already settled; its outcome is retained for awaitAction only.",
        );
      throw providerError("notification-expired", "The notification is unknown or expired.");
    }
    if (record.ownerId !== callerOf(metadata).installationId)
      throw providerError(
        "notification-owner-mismatch",
        "Notifications can only be managed by their owning installation.",
      );
    return record;
  };

  /** A click on a `keepOpen` action: wakes current waiters, or queues for the next one. */
  const recordClick = (notificationId: string, actionId: string) => {
    const record = live.get(notificationId);
    if (!record) return;
    if (record.waiters.length === 0) {
      record.clicks.push(actionId);
      record.clicks.splice(0, Math.max(0, record.clicks.length - PENDING_CLICKS_CAP));
      return;
    }
    for (const waiter of record.waiters.splice(0)) waiter.resolve({ actionId });
  };

  /**
   * Whether the connection's `apiId` area carries `range`. Additions to an
   * area render only on a client that registered a version inside it; an
   * older one would reject the frame. A client that lists no version for the
   * area has none of its additions.
   */
  /** The version of `apiId` the client on `connectionId` lists, if any. */
  const clientVersion = async (connectionId: string, apiId: string, signal: AbortSignal) => {
    const targets = await Effect.runPromise(
      deps.clientApiProviders.listTargets(deps.environmentId),
      { signal },
    );
    return targets
      .find((target) => target.connectionId === connectionId)
      ?.providers.find((provider) => provider.id === apiId)?.version;
  };

  const clientSupports = async (
    connectionId: string,
    apiId: string,
    range: string,
    signal: AbortSignal,
  ) => {
    const version = await clientVersion(connectionId, apiId, signal);
    // An unlisted area is not a current one: the client is refused, never guessed.
    return { ok: version !== undefined && satisfiesSemverRange(version, range), version };
  };

  /** Names the gap instead of sending a client a frame its area predates. */
  const requireClient = async (
    connectionId: string,
    apiId: string,
    range: string,
    operation: string,
    signal: AbortSignal,
  ) => {
    const { ok, version } = await clientSupports(connectionId, apiId, range, signal);
    if (!ok)
      throw providerError(
        "provider-rejected",
        `${operation} needs ${apiId} ${range}; this client ${version === undefined ? "does not provide it" : "runs " + version}.`,
      );
  };

  const requireNotificationsV11 = (connectionId: string, operation: string, signal: AbortSignal) =>
    requireClient(
      connectionId,
      CLIENT_NOTIFICATIONS,
      CLIENT_NOTIFICATIONS_V11_RANGE,
      operation,
      signal,
    );

  /**
   * The preferences target plus the later keys it may answer with. A client
   * is asked only for keys its area has, and an older server never asks, so
   * neither side sees a field its closed shapes reject.
   */
  const preferencesTarget = async (metadata: HostApiInvocationMetadata, signal: AbortSignal) => {
    const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), { signal });
    const version = await clientVersion(connectionId, CLIENT_PREFERENCES, signal);
    const has = (range: string) => version !== undefined && satisfiesSemverRange(version, range);
    const include = [
      ...(has(CLIENT_PREFERENCES_V11_RANGE) ? ["renderBrowserFile"] : []),
      ...(has(CLIENT_PREFERENCES_V12_RANGE) ? ["fileExplorerOpen"] : []),
    ];
    return { connectionId, include: include.length > 0 ? { include } : {} };
  };

  /**
   * Whether the invoking client has a preview browser: its own 1.2.0
   * navigation answer. An older client, or one that cannot be reached, has none.
   */
  const opensFilesInBrowser = async (
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ): Promise<boolean> => {
    if (metadata.principal?.kind === "provider-session") return false;
    try {
      const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
        signal,
      });
      const { ok } = await clientSupports(
        connectionId,
        CLIENT_NAVIGATION,
        CLIENT_NAVIGATION_V12_RANGE,
        signal,
      );
      if (!ok) return false;
      const answer = await Effect.runPromise(
        invokeClient(deps, {
          apiId: CLIENT_NAVIGATION,
          method: "getCapabilities",
          input: {},
          context,
          metadata,
          signal,
          connectionId,
        }),
        { signal },
      );
      return (answer as { openFileInBrowser?: unknown }).openFileInBrowser === true;
    } catch {
      return false;
    }
  };

  const themeProvider: HostApiProvider = {
    providerId: "host.ui.theme",
    definition: UI_THEME_API,
    availability: ambient(deps, CLIENT_THEME),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      switch (method) {
        case "getCapabilities":
          return capabilities(
            deps,
            "host.ui.theme",
            {
              getState: CLIENT_THEME,
              getTokens: CLIENT_THEME,
              setPreference: CLIENT_THEME,
              subscribeState: CLIENT_THEME,
              getTerminalAppearance: CLIENT_TERMINAL_APPEARANCE,
              subscribeTerminalAppearance: CLIENT_TERMINAL_APPEARANCE,
            },
            metadata,
          );
        case "getState":
          return forward(deps, CLIENT_THEME, "getState")(method, input, context, signal, metadata);
        case "getTokens":
          return forward(deps, CLIENT_THEME, "resolveTokens")(
            method,
            input,
            context,
            signal,
            metadata,
          );
        case "setPreference": {
          const writer = callerOf(metadata).installationId;
          return forward(deps, CLIENT_THEME, "applyPreference")(
            method,
            { writer, preference: input } as Json,
            context,
            signal,
            metadata,
          );
        }
        case "getTerminalAppearance":
          return forward(deps, CLIENT_TERMINAL_APPEARANCE, "getAppearance")(
            method,
            input,
            context,
            signal,
            metadata,
          );
        default:
          return Promise.reject(
            providerError("client-provider-unavailable", `Unknown theme op: ${method}`),
          );
      }
    },
    subscribe(name, input, context, signal, metadata) {
      if (name === "subscribeState")
        return streamThrough(deps, {
          apiId: CLIENT_THEME,
          clientName: "watchState",
          input,
          context,
          signal,
          metadata,
          coalesce: true,
        });
      if (name === "subscribeTerminalAppearance")
        return streamThrough(deps, {
          apiId: CLIENT_TERMINAL_APPEARANCE,
          clientName: "watchAppearance",
          input,
          context,
          signal,
          metadata,
          coalesce: true,
        });
      throw providerError("client-provider-unavailable", `Unknown theme stream: ${name}`);
    },
  };

  const keybindingsProvider: HostApiProvider = {
    providerId: "host.ui.keybindings",
    definition: UI_KEYBINDINGS_API,
    availability: ambient(deps, CLIENT_KEYBINDINGS),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      switch (method) {
        case "getCapabilities":
          return capabilities(
            deps,
            "host.ui.keybindings",
            {
              registerCommands: CLIENT_KEYBINDINGS,
              unregisterCommands: CLIENT_KEYBINDINGS,
              listConflicts: CLIENT_KEYBINDINGS,
            },
            metadata,
          );
        case "registerCommands":
          return (async () => {
            const commands = (input as { commands: { id: string; scope: string }[] }).commands;
            const caller = callerOf(metadata);
            const rejected: { commandId: string; status: "rejected"; reason: string }[] = [];
            let globalAllowed: boolean | undefined;
            const accepted: Json[] = [];
            for (const command of commands) {
              if (command.scope === "global") {
                globalAllowed ??= await deps.authorizeGrant(
                  caller.installationId,
                  UI_KEYBINDINGS_GLOBAL,
                  context,
                );
                if (!globalAllowed) {
                  rejected.push({
                    commandId: command.id,
                    status: "rejected",
                    reason: `${UI_KEYBINDINGS_GLOBAL} grant required`,
                  });
                  continue;
                }
              }
              accepted.push(command as Json);
            }
            if (!accepted.length) {
              // The output contract requires a token; mint a void one and keep
              // it so a later unregister resolves honestly instead of
              // forwarding a token the client never registered.
              const token = `cmdset-${NodeCrypto.randomUUID()}`;
              voidTokens.add(token);
              if (voidTokens.size > 256) {
                const oldest = voidTokens.values().next().value;
                if (oldest !== undefined) voidTokens.delete(oldest);
              }
              return { commandSetToken: token, results: rejected } satisfies Json;
            }
            const result = (await Effect.runPromise(
              invokeClient(deps, {
                apiId: CLIENT_KEYBINDINGS,
                method: "registerCommands",
                // Installation scope is derived from the host-owned install
                // context, not from anything the caller asserts — the staged
                // flush marks itself with the `t3.extensions` namespace.
                input: {
                  installationScoped:
                    context.resource.namespace === "t3.extensions" &&
                    context.resource.id === caller.installationId,
                  commands: accepted,
                } as Json,
                context,
                metadata,
                signal,
              }),
              { signal },
            )) as { commandSetToken: string; results: Json[] };
            return {
              commandSetToken: result.commandSetToken,
              results: [...rejected, ...result.results],
            } satisfies Json;
          })();
        case "unregisterCommands": {
          const token = (input as { commandSetToken: string }).commandSetToken;
          if (voidTokens.delete(token))
            return Promise.resolve({ unregistered: true } satisfies Json);
          return forward(deps, CLIENT_KEYBINDINGS, "unregisterCommands")(
            method,
            input,
            context,
            signal,
            metadata,
          );
        }
        case "listConflicts":
          return forward(deps, CLIENT_KEYBINDINGS, "listConflicts")(
            method,
            input,
            context,
            signal,
            metadata,
          );
        default:
          return Promise.reject(
            providerError("client-provider-unavailable", `Unknown keybindings op: ${method}`),
          );
      }
    },
  };

  const notificationsProvider: HostApiProvider = {
    providerId: "host.ui.notifications",
    definition: UI_NOTIFICATIONS_API,
    availability: ambient(deps, CLIENT_NOTIFICATIONS),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      switch (method) {
        case "getCapabilities":
          return capabilities(
            deps,
            "host.ui.notifications",
            {
              notify: CLIENT_NOTIFICATIONS,
              update: CLIENT_NOTIFICATIONS,
              dismiss: CLIENT_NOTIFICATIONS,
              awaitAction: CLIENT_NOTIFICATIONS,
            },
            metadata,
          );
        case "notify":
          return (async () => {
            const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
              signal,
            });
            const actions = (input as { actions?: readonly { keepOpen?: boolean }[] }).actions;
            if (actions?.some((action) => action.keepOpen !== undefined))
              await requireNotificationsV11(connectionId, "A keepOpen action", signal);
            const notificationId = `ntf-${NodeCrypto.randomUUID()}`;
            const record: LiveNotification = {
              ownerId: callerOf(metadata).installationId,
              connectionId,
              clicks: [],
              waiters: [],
            };
            live.set(notificationId, record);
            try {
              // Correlation first, awaited — an outcome emitted the instant
              // the client handles `notify` must not arrive unregistered.
              await Effect.runPromise(
                deps.clientApiProviders.registerCorrelation(notificationId, {
                  connectionId,
                  kind: "notification",
                  deliver: (event) => {
                    if (event.type === "notificationAction") {
                      recordClick(notificationId, event.actionId);
                      return;
                    }
                    if (event.type !== "notificationOutcome") return;
                    const outcome = event.outcome as NotificationOutcome;
                    recordOutcome(
                      notificationId,
                      outcome.actionId ? { actionId: outcome.actionId } : { dismissed: true },
                      record.ownerId,
                      record.connectionId,
                    );
                  },
                  revoked: () =>
                    expireNotification(
                      notificationId,
                      providerError(
                        "client-provider-unavailable",
                        "The client provider connection closed.",
                      ),
                    ),
                }),
                { signal },
              );
              await Effect.runPromise(
                invokeClient(deps, {
                  apiId: CLIENT_NOTIFICATIONS,
                  method: "notify",
                  input: {
                    notification: {
                      notificationId,
                      ...(input as Record<string, unknown>),
                    },
                  } as Json,
                  context,
                  metadata,
                  signal,
                  connectionId,
                }),
                { signal },
              );
              return { notificationId } satisfies Json;
            } catch (error) {
              live.delete(notificationId);
              Effect.runFork(deps.clientApiProviders.unregisterCorrelation(notificationId));
              throw error;
            }
          })();
        case "update": {
          const notificationId = (input as { notificationId: string }).notificationId;
          return (async () => {
            const record = ownedNotification(notificationId, metadata);
            const { notificationId: _omit, ...patch } = input as Record<string, unknown>;
            if (patch.flashAction !== undefined)
              await requireNotificationsV11(record.connectionId, "flashAction", signal);
            return Effect.runPromise(
              invokeClient(deps, {
                apiId: CLIENT_NOTIFICATIONS,
                method: "update",
                input: { notificationId, patch } as Json,
                context,
                metadata,
                signal,
              }),
              { signal },
            );
          })();
        }
        case "dismiss": {
          const notificationId = (input as { notificationId: string }).notificationId;
          return (async () => {
            const record = ownedNotification(notificationId, metadata);
            const result = await Effect.runPromise(
              invokeClient(deps, {
                apiId: CLIENT_NOTIFICATIONS,
                method: "dismiss",
                input: { notificationId } as Json,
                context,
                metadata,
                signal,
              }),
              { signal },
            );
            // A dismiss through the API counts as the settled outcome.
            if ((result as { dismissed?: boolean }).dismissed) {
              recordOutcome(
                notificationId,
                { dismissed: true },
                record.ownerId,
                record.connectionId,
              );
            }
            return result;
          })();
        }
        case "awaitAction": {
          const notificationId = (input as { notificationId: string }).notificationId;
          return (async () => {
            // Outcomes are connection-owned: resolve the caller's own target
            // so provider sessions and foreign connections cannot read a
            // retained or live outcome they did not create.
            if (
              metadata.principal?.kind !== "host" &&
              metadata.principal?.kind !== "environment-session"
            )
              throw providerError(
                "client-target-denied",
                "Provider sessions cannot await notification outcomes.",
              );
            const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
              signal,
            });
            const retained = settleOutcome(notificationId);
            if (retained) {
              if (
                retained.ownerId !== callerOf(metadata).installationId ||
                retained.connectionId !== connectionId
              )
                throw providerError(
                  "notification-owner-mismatch",
                  "Notifications can only be managed by their owning installation and connection.",
                );
              const queued = retained.clicks.shift();
              if (queued !== undefined) return { actionId: queued } satisfies Json;
              return retained.outcome as unknown as Json;
            }
            const record = ownedNotification(notificationId, metadata);
            if (record.connectionId !== connectionId)
              throw providerError(
                "notification-owner-mismatch",
                "Notifications can only be managed by their owning connection.",
              );
            const queued = record.clicks.shift();
            if (queued !== undefined) return { actionId: queued } satisfies Json;
            return new Promise<Json>((resolve, reject) => {
              const waiter = {
                resolve: (outcome: NotificationOutcome) => resolve(outcome as Json),
                reject,
              };
              record.waiters.push(waiter);
              const onAbort = () => {
                const index = record.waiters.indexOf(waiter);
                if (index >= 0) record.waiters.splice(index, 1);
                reject(signal.reason ?? new Error("awaitAction cancelled"));
              };
              signal.addEventListener("abort", onAbort, { once: true });
            });
          })();
        }
        default:
          return Promise.reject(
            providerError("client-provider-unavailable", `Unknown notifications op: ${method}`),
          );
      }
    },
  };

  const panelsProvider: HostApiProvider = {
    providerId: "host.ui.panels",
    definition: UI_PANELS_API,
    availability: ambient(deps, CLIENT_PANELS),
    async invoke(method, input, context, signal, metadata): Promise<Json> {
      if (method === "getCapabilities") {
        const reported = await capabilities(
          deps,
          "host.ui.panels",
          {
            openSurface: CLIENT_PANELS,
            activateSurface: CLIENT_PANELS,
            closeSurface: CLIENT_PANELS,
            listSurfaces: CLIENT_PANELS,
            hideDock: CLIENT_PANELS,
            showDock: CLIENT_PANELS,
            getBrowserMiniPlayer: CLIENT_PANELS,
            setBrowserMiniPlayer: CLIENT_PANELS,
          },
          metadata,
        );
        const report = reported as { operations: Record<string, boolean> };
        const reachable =
          report.operations.getBrowserMiniPlayer && context.resource.threadId !== undefined;
        report.operations.getBrowserMiniPlayer = false;
        report.operations.setBrowserMiniPlayer = false;
        if (reachable) {
          try {
            const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
              signal,
            });
            const supported = await clientSupports(
              connectionId,
              CLIENT_PANELS,
              CLIENT_PANELS_V11_RANGE,
              signal,
            );
            const clientCapabilities = supported.ok
              ? await Effect.runPromise(
                  invokeClient(deps, {
                    apiId: CLIENT_PANELS,
                    method: "getCapabilities",
                    input: {},
                    context,
                    metadata,
                    signal,
                    connectionId,
                  }),
                  { signal },
                )
              : null;
            const available =
              supported.ok &&
              clientCapabilities !== null &&
              typeof clientCapabilities === "object" &&
              !Array.isArray(clientCapabilities) &&
              "browserMiniPlayer" in clientCapabilities &&
              clientCapabilities.browserMiniPlayer === true;
            report.operations.getBrowserMiniPlayer = available;
            report.operations.setBrowserMiniPlayer = available;
          } catch (error) {
            if (signal.aborted) throw error;
          }
        }
        return reported;
      }
      const clientMethod = (
        {
          openSurface: "openSurface",
          activateSurface: "activateSurface",
          closeSurface: "closeSurface",
          listSurfaces: "listSurfaces",
          hideDock: "hideDock",
          showDock: "showDock",
          getBrowserMiniPlayer: "getBrowserMiniPlayer",
          setBrowserMiniPlayer: "setBrowserMiniPlayer",
        } as Record<string, string>
      )[method];
      if (!clientMethod)
        return Promise.reject(
          providerError("client-provider-unavailable", `Unknown panels op: ${method}`),
        );
      return (async () => {
        const fields = input as Record<string, unknown>;
        // Panel ops are ScopedThreadRef-only: an input threadId may name the
        // context's own thread and nothing else.
        const scoped = context.resource.threadId;
        if (fields.threadId !== undefined && fields.threadId !== scoped)
          throw providerError(
            "client-target-denied",
            "Panel target is outside the granted thread scope.",
          );
        const threadId = (fields.threadId as string | undefined) ?? scoped;
        if (!threadId)
          throw providerError(
            "client-target-denied",
            "Panel operations require a thread-scoped context.",
          );
        const connectionId =
          method === "getBrowserMiniPlayer" || method === "setBrowserMiniPlayer"
            ? await Effect.runPromise(resolveConnectionId(deps, metadata), { signal })
            : undefined;
        if (connectionId !== undefined)
          await requireClient(connectionId, CLIENT_PANELS, CLIENT_PANELS_V11_RANGE, method, signal);
        return Effect.runPromise(
          invokeClient(deps, {
            apiId: CLIENT_PANELS,
            method: clientMethod,
            input: { ...fields, threadId } as Json,
            context,
            metadata,
            signal,
            ...(connectionId !== undefined ? { connectionId } : {}),
          }),
          { signal },
        );
      })();
    },
  };

  const preferencesProvider: HostApiProvider = {
    providerId: "host.ui.preferences",
    definition: UI_PREFERENCES_API,
    availability: ambient(deps, CLIENT_PREFERENCES),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      switch (method) {
        case "getCapabilities":
          return capabilities(
            deps,
            "host.ui.preferences",
            {
              getPreferences: CLIENT_PREFERENCES,
              setPreferences: CLIENT_PREFERENCES,
              subscribePreferences: CLIENT_PREFERENCES,
            },
            metadata,
          );
        case "getPreferences":
        case "setPreferences":
          return (async () => {
            const { connectionId, include } = await preferencesTarget(metadata, signal);
            const write = method === "setPreferences";
            const patch = input as { renderBrowserFile?: unknown; fileExplorerOpen?: unknown };
            if (write && patch.renderBrowserFile !== undefined)
              await requireClient(
                connectionId,
                CLIENT_PREFERENCES,
                CLIENT_PREFERENCES_V11_RANGE,
                "renderBrowserFile",
                signal,
              );
            if (write && patch.fileExplorerOpen !== undefined)
              await requireClient(
                connectionId,
                CLIENT_PREFERENCES,
                CLIENT_PREFERENCES_V12_RANGE,
                "fileExplorerOpen",
                signal,
              );
            return Effect.runPromise(
              invokeClient(deps, {
                apiId: CLIENT_PREFERENCES,
                method: write ? "applyPreferences" : "getPreferences",
                input: (write
                  ? { writer: callerOf(metadata).installationId, patch: input, ...include }
                  : include) as Json,
                context,
                metadata,
                signal,
                connectionId,
              }),
              { signal },
            );
          })();
        default:
          return Promise.reject(
            providerError("client-provider-unavailable", `Unknown preferences op: ${method}`),
          );
      }
    },
    subscribe(name, input, context, signal, metadata) {
      if (name === "subscribePreferences")
        return streamThrough(deps, {
          apiId: CLIENT_PREFERENCES,
          clientName: "watchPreferences",
          input,
          context,
          signal,
          metadata,
          coalesce: true,
          prepare: async () => {
            const { connectionId, include } = await preferencesTarget(metadata, signal);
            return { connectionId, input: include as Json };
          },
        });
      throw providerError("client-provider-unavailable", `Unknown preferences stream: ${name}`);
    },
  };

  const externalProvider: HostApiProvider = {
    providerId: "host.ui.external",
    definition: UI_EXTERNAL_API,
    availability: ambient(deps, CLIENT_EXTERNAL),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      if (method === "getCapabilities")
        return capabilities(
          deps,
          "host.ui.external",
          { open: CLIENT_EXTERNAL, openLink: CLIENT_EXTERNAL },
          metadata,
        );
      if (method !== "open" && method !== "openLink")
        return Promise.reject(
          providerError("client-provider-unavailable", `Unknown external op: ${method}`),
        );
      // A refused URL never reaches a client: the receipt names the reason.
      const { url, forceSystem } = input as { url: string; forceSystem?: boolean };
      const checked = checkExternalUrl(url);
      if (!checked.ok)
        return Promise.resolve({ status: "refused", reason: checked.reason } satisfies Json);
      if (method === "open")
        return forward(deps, CLIENT_EXTERNAL, "open")(
          method,
          { url: checked.url },
          context,
          signal,
          metadata,
        );
      // `openLink` is 1.1.0: the "Open links in" setting is client state, so
      // the caller's own client decides between its preview browser and the
      // OS opener. A 1.0.0 client has no setting-aware open and keeps the
      // system browser it always used.
      return (async () => {
        const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
          signal,
        });
        const { ok } = await clientSupports(
          connectionId,
          CLIENT_EXTERNAL,
          CLIENT_EXTERNAL_V11_RANGE,
          signal,
        );
        return Effect.runPromise(
          invokeClient(deps, {
            apiId: CLIENT_EXTERNAL,
            method: ok ? "openLink" : "open",
            input: {
              url: checked.url,
              ...(ok && forceSystem === true ? { forceSystem } : {}),
            },
            context,
            metadata,
            signal,
            connectionId,
          }),
          { signal },
        );
      })();
    },
  };

  // The preferred editor is client state, so the caller's own client resolves
  // the path and editor, then launches through its environment like native.
  const editorProvider: HostApiProvider = {
    providerId: "host.ui.editor",
    definition: UI_EDITOR_API,
    availability: ambient(deps, CLIENT_EDITOR),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      if (method === "getCapabilities")
        return (async () => {
          const base = (await capabilities(
            deps,
            "host.ui.editor",
            { openPath: CLIENT_EDITOR },
            metadata,
          )) as { adapter: string; operations: Record<string, boolean>; clients: Json[] };
          if (metadata.principal?.kind === "provider-session") return base;
          const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
            signal,
          });
          const { ok } = await clientSupports(
            connectionId,
            CLIENT_EDITOR,
            CLIENT_EDITOR_V11_RANGE,
            signal,
          );
          if (!ok) return { ...base, operations: { openPath: false } };
          const answer = (await Effect.runPromise(
            invokeClient(deps, {
              apiId: CLIENT_EDITOR,
              method,
              input: {},
              context,
              signal,
              metadata,
              connectionId,
            }),
            { signal },
          )) as { editor?: Json; operations?: Json };
          return {
            ...base,
            operations: answer.operations ?? { openPath: false },
            ...(answer.editor === undefined ? {} : { editor: answer.editor }),
          };
        })();
      if (method !== "openPath")
        return Promise.reject(
          providerError("client-provider-unavailable", `Unknown editor op: ${method}`),
        );
      return (async () => {
        const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
          signal,
        });
        if ((input as { workspace?: unknown }).workspace === true)
          await requireClient(
            connectionId,
            CLIENT_EDITOR,
            CLIENT_EDITOR_V11_RANGE,
            "workspace openPath",
            signal,
          );
        return Effect.runPromise(
          invokeClient(deps, {
            apiId: CLIENT_EDITOR,
            method: "openPath",
            input,
            context,
            signal,
            metadata,
            connectionId,
          }),
          { signal },
        );
      })();
    },
  };

  // `t3.browser/history` lives with the `t3.ui/*` adapters because it rides the
  // same client-provider seam: history is the client's native per-project store.
  const browserHistoryProvider: HostApiProvider = {
    providerId: "host.browser.history",
    definition: browserHistoryApi.definition,
    availability: ambient(deps, CLIENT_BROWSER_HISTORY),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      if (!["list", "record", "setTitle", "remove"].includes(method))
        return Promise.reject(
          providerError("client-provider-unavailable", `Unknown browser history op: ${method}`),
        );
      // The client resolves the project from the context thread; a caller
      // without one has no project history to reach.
      if (!context.resource.threadId)
        return Promise.reject(
          providerError(
            "client-target-denied",
            "Browser history requires a thread-scoped context.",
          ),
        );
      return forward(deps, CLIENT_BROWSER_HISTORY, method)(
        method,
        input,
        context,
        signal,
        metadata,
      );
    },
  };

  const navigationProvider: HostApiProvider = {
    providerId: "host.ui.navigation",
    definition: UI_NAVIGATION_API,
    availability: ambient(deps, CLIENT_NAVIGATION),
    invoke(method, input, context, signal, metadata): Promise<Json> {
      if (method === "getCapabilities")
        return (async () => {
          const answer = (await capabilities(
            deps,
            "host.ui.navigation",
            {
              openThread: CLIENT_NAVIGATION,
              openAgentSession: CLIENT_NAVIGATION,
              openFile: CLIENT_NAVIGATION,
            },
            metadata,
          )) as { readonly operations: Record<string, boolean> };
          return {
            ...answer,
            operations: {
              ...answer.operations,
              openFileInBrowser: await opensFilesInBrowser(context, signal, metadata),
            },
          } as unknown as Json;
        })();
      if (method === "openAgentSession")
        return (async () => {
          const { agentId } = input as { agentId: string };
          // Only the caller's own (broker-scoped) thread; the input cannot name another.
          const threadId = context.resource.threadId;
          const agents = threadId ? await deps.readThreadAgentSessions(threadId) : null;
          if (agents === null)
            return { status: "refused", reason: "unknown-thread" } satisfies Json;
          const agent = agents.find((candidate) => candidate.id === agentId);
          if (!agent) return { status: "refused", reason: "unknown-agent" } satisfies Json;
          const checked = agent.sessionUrl ? checkExternalUrl(agent.sessionUrl) : null;
          if (!checked?.ok) return { status: "refused", reason: "no-session" } satisfies Json;
          return forward(deps, CLIENT_NAVIGATION, "openSession")(
            method,
            { agentId, url: checked.url },
            context,
            signal,
            metadata,
          );
        })();
      if (method === "openFile")
        return (async () => {
          const { relativePath, line, openIn } = input as {
            relativePath: string;
            line?: number;
            openIn?: "panel" | "browser";
          };
          const browser = openIn === "browser";
          if (!isWorkspaceFilePath(relativePath))
            return { status: "refused", reason: "invalid-path" } satisfies Json;
          // Only the caller's own (broker-scoped) thread; the input cannot name another.
          const threadId = context.resource.threadId;
          const project = threadId ? await deps.resolveThreadProject(threadId) : null;
          if (project === null)
            return { status: "refused", reason: "unknown-thread" } satisfies Json;
          if (project !== context.resource.projectId)
            return { status: "refused", reason: "out-of-scope" } satisfies Json;
          const connectionId = await Effect.runPromise(resolveConnectionId(deps, metadata), {
            signal,
          });
          // `openIn` is 1.2.0; the file panel is the 1.1.0 default, so only
          // a browser open needs the newer client.
          await requireClient(
            connectionId,
            CLIENT_NAVIGATION,
            browser ? CLIENT_NAVIGATION_V12_RANGE : CLIENT_NAVIGATION_V11_RANGE,
            browser ? "openFile openIn" : "openFile",
            signal,
          );
          return Effect.runPromise(
            invokeClient(deps, {
              apiId: CLIENT_NAVIGATION,
              method: "openFile",
              input: {
                relativePath,
                ...(line === undefined ? {} : { line }),
                ...(browser ? { openIn } : {}),
              },
              context,
              metadata,
              signal,
              connectionId,
            }),
            { signal },
          );
        })();
      if (method !== "openThread")
        return Promise.reject(
          providerError("client-provider-unavailable", `Unknown navigation op: ${method}`),
        );
      return (async () => {
        const { threadId, surfaceId } = input as { threadId: string; surfaceId?: string };
        // The broker already scoped the caller's context to a granted
        // project; a target outside that project never reaches a client.
        const targetProject = await deps.resolveThreadProject(threadId);
        if (targetProject === null)
          return { status: "refused", reason: "unknown-thread" } satisfies Json;
        if (targetProject !== context.resource.projectId)
          return { status: "refused", reason: "out-of-scope" } satisfies Json;
        return forward(deps, CLIENT_NAVIGATION, "openThread")(
          method,
          { threadId, ...(surfaceId === undefined ? {} : { surfaceId }) },
          context,
          signal,
          metadata,
        );
      })();
    },
  };

  return [
    themeProvider,
    keybindingsProvider,
    notificationsProvider,
    panelsProvider,
    preferencesProvider,
    externalProvider,
    editorProvider,
    browserHistoryProvider,
    navigationProvider,
  ];
}
