import * as NodeCrypto from "node:crypto";
import {
  ClientProvidersError,
  ExtensionViewContext,
  type ClientProviderCaller,
} from "@t3tools/contracts";
import {
  UI_KEYBINDINGS_API,
  UI_KEYBINDINGS_GLOBAL,
  UI_NOTIFICATIONS_API,
  UI_PANELS_API,
  UI_THEME_API,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ClientApiProviders } from "./ClientApiProviders.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
/** Notification outcomes stay resolvable by `awaitAction` for one minute. */
const OUTCOME_RETENTION_MS = 60_000;
const OUTCOME_RETENTION_CAP = 256;

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
}

const providerError = (code: string, detail: string) =>
  new ClientProvidersError({ code, detail: detail.slice(0, 2000) });

const decodeContext = Schema.decodeUnknownSync(ExtensionViewContext);

/** The broker-verified immediate caller, minted into the client frame. */
export const callerOf = (metadata: HostApiInvocationMetadata): ClientProviderCaller => {
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
  },
): Effect.Effect<
  { readonly events: AsyncIterable<ApiStreamEvent>; readonly close: () => Effect.Effect<void> },
  ClientProvidersError
> =>
  Effect.gen(function* () {
    const connectionId = yield* resolveConnectionId(deps, request.metadata);
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
  },
): AsyncIterable<ApiStreamEvent> =>
  (async function* () {
    const subscription = await Effect.runPromise(
      openClientStream(deps, {
        apiId: request.apiId,
        name: request.clientName,
        input: request.input,
        context: request.context,
        metadata: request.metadata,
        ...(request.coalesce !== undefined ? { coalesce: request.coalesce } : {}),
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

interface NotificationOutcome {
  readonly actionId?: string;
  readonly dismissed?: true;
}
interface LiveNotification {
  readonly ownerId: string;
  /** The seam connection the toast lives on — outcomes stay connection-owned. */
  readonly connectionId: string;
  readonly waiters: {
    resolve: (outcome: NotificationOutcome) => void;
    reject: (error: unknown) => void;
  }[];
}

export function createUiClientApiProviders(deps: UiClientBridgeDeps): readonly HostApiProvider[] {
  /** Live notifications, keyed by server-minted notificationId. */
  const live = new Map<string, LiveNotification>();
  /** Settled outcomes retained for 60 s so late `awaitAction` calls resolve. */
  const outcomes = new Map<
    string,
    {
      outcome: NotificationOutcome;
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
    if (record) {
      live.delete(notificationId);
      for (const waiter of record.waiters.splice(0)) waiter.resolve(outcome);
    }
    outcomes.set(notificationId, {
      outcome,
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
            const notificationId = `ntf-${NodeCrypto.randomUUID()}`;
            const record: LiveNotification = {
              ownerId: callerOf(metadata).installationId,
              connectionId,
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
            ownedNotification(notificationId, metadata);
            const { notificationId: _omit, ...patch } = input as Record<string, unknown>;
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
              return retained.outcome as unknown as Json;
            }
            const record = ownedNotification(notificationId, metadata);
            if (record.connectionId !== connectionId)
              throw providerError(
                "notification-owner-mismatch",
                "Notifications can only be managed by their owning connection.",
              );
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
    invoke(method, input, context, signal, metadata): Promise<Json> {
      if (method === "getCapabilities")
        return capabilities(
          deps,
          "host.ui.panels",
          {
            openSurface: CLIENT_PANELS,
            activateSurface: CLIENT_PANELS,
            closeSurface: CLIENT_PANELS,
            listSurfaces: CLIENT_PANELS,
            hideDock: CLIENT_PANELS,
            showDock: CLIENT_PANELS,
          },
          metadata,
        );
      const clientMethod = (
        {
          openSurface: "openSurface",
          activateSurface: "activateSurface",
          closeSurface: "closeSurface",
          listSurfaces: "listSurfaces",
          hideDock: "hideDock",
          showDock: "showDock",
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
        return Effect.runPromise(
          invokeClient(deps, {
            apiId: CLIENT_PANELS,
            method: clientMethod,
            input: { ...fields, threadId } as Json,
            context,
            metadata,
            signal,
          }),
          { signal },
        );
      })();
    },
  };

  return [themeProvider, keybindingsProvider, notificationsProvider, panelsProvider];
}
