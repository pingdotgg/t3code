import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Access.McpServer" as const;
type TypeId = typeof TypeId;

/**
 * Authentication method the gateway uses to reach the upstream MCP server.
 */
export type McpServerAuthType = "oauth" | "bearer" | "unauthenticated";

/**
 * Capability sync state reported by Cloudflare for an MCP server.
 */
export type McpServerStatus = "waiting" | "ready" | "stale" | "error";

/**
 * Whether administrative authentication is required before the server's
 * capabilities can be synced.
 */
export type McpServerAuthenticationStatus =
  | "not_required"
  | "required"
  | "connected"
  | "stale"
  | "manual";

/**
 * A server-wide override for a single tool or prompt exposed by the
 * upstream MCP server.
 */
export interface McpServerCapabilityOverride {
  /**
   * Name of the tool or prompt capability to override.
   */
  name: string;
  /**
   * Custom name exposed for the capability.
   */
  alias?: string;
  /**
   * Custom description exposed for the capability.
   */
  description?: string;
  /**
   * Whether the capability is available through the MCP server.
   */
  enabled?: boolean;
}

/**
 * A tool or prompt discovered from the upstream MCP server by a capability
 * sync. The shape is whatever the upstream advertises (typically `name`,
 * `description`, and an input schema).
 */
export type McpServerCapability = Record<string, unknown>;

export interface McpServerProps {
  /**
   * The client-supplied server identifier. Immutable — changing it
   * triggers a replacement. If omitted, a deterministic id is generated
   * from the stack, stage, logical ID, and resource instance, capped at
   * the API's 32-character limit.
   * @default a generated ID of at most 32 characters
   */
  serverId?: string;
  /**
   * Display name of the server. If omitted, the server id is reused.
   * @default the server id
   */
  name?: string;
  /**
   * URL of the upstream MCP endpoint, e.g. `https://mcp.example.com/mcp`.
   * Create-only on the API: changing it triggers a delete-first replacement.
   */
  hostname: string;
  /**
   * Authentication method used to connect to the upstream MCP server.
   * Create-only on the API: changing it triggers a delete-first replacement.
   */
  authType: McpServerAuthType;
  /**
   * Static credential for the upstream MCP server. For `bearer`, either a
   * raw token (sent as `Authorization: Bearer <token>`) or a JSON-encoded
   * `{"headers":{...}}` object for custom or multiple static headers, e.g.
   * a Cloudflare Access service token. For `oauth`, the JSON-encoded OAuth
   * configuration. Write-only — the API never returns it, so rotation is
   * detected by comparing against the previously deployed value.
   */
  authCredentials?: Redacted.Redacted<string>;
  /**
   * Pre-registered OAuth `client_secret` for manually configured OAuth
   * servers. Write-only — never returned by the API.
   */
  clientSecret?: Redacted.Redacted<string>;
  /**
   * Optional description of the server.
   */
  description?: string;
  /**
   * Route outbound traffic to this server through the Zero Trust Secure
   * Web Gateway.
   * @default false
   */
  secureWebGateway?: boolean;
  /**
   * Use the shared Cloudflare-owned OAuth callback endpoint as the
   * `redirect_uri` for upstream on-behalf OAuth instead of the portal
   * hostname.
   * @default false
   */
  isSharedOauthCallbackEnabled?: boolean;
  /**
   * Server-wide tool overrides: disable, rename, or re-describe tools the
   * upstream advertises. When omitted, the observed overrides are kept.
   */
  updatedTools?: McpServerCapabilityOverride[];
  /**
   * Server-wide prompt overrides: disable, rename, or re-describe prompts
   * the upstream advertises. When omitted, the observed overrides are kept.
   */
  updatedPrompts?: McpServerCapabilityOverride[];
  /**
   * Run a capability sync (tool and prompt discovery against the upstream)
   * after the server is created, its configuration changes, or sync is
   * enabled after being disabled. Discovery
   * problems are reported on the `status` and `error` attributes and never
   * fail the deploy. Skipped while the server still requires an
   * administrator to complete its OAuth authentication. Cloudflare may
   * independently discover capabilities even when this option is false.
   * @default true
   */
  sync?: boolean;
}

export type McpServerAttributes = {
  /** The server id. */
  serverId: string;
  /** Account that owns the server. */
  accountId: string;
  /** Observed display name. */
  name: string;
  /** Observed upstream MCP endpoint URL. */
  hostname: string;
  /** Observed authentication method. */
  authType: McpServerAuthType;
  /** Observed description, if any. */
  description: string | undefined;
  /** Whether outbound traffic routes through the gateway. */
  secureWebGateway: boolean;
  /** Whether the shared Cloudflare OAuth callback is used. */
  isSharedOauthCallbackEnabled: boolean;
  /** Observed server-wide tool overrides. */
  updatedTools: McpServerCapabilityOverride[];
  /** Observed server-wide prompt overrides. */
  updatedPrompts: McpServerCapabilityOverride[];
  /** Tools discovered by the last successful capability sync. */
  tools: McpServerCapability[];
  /** Prompts discovered by the last successful capability sync. */
  prompts: McpServerCapability[];
  /** Current capability sync state, if reported. */
  status: McpServerStatus | undefined;
  /** Whether administrative OAuth authentication is still required. */
  authenticationStatus: McpServerAuthenticationStatus | undefined;
  /** Error from the last capability sync, if any. */
  error: string | undefined;
  /** RFC 3339 timestamp of the last sync attempt, if reported. */
  lastSynced: string | undefined;
  /** RFC 3339 timestamp of the last successful sync, if reported. */
  lastSuccessfulSync: string | undefined;
  /** RFC 3339 timestamp of when the server was created, if reported. */
  createdAt: string | undefined;
};

export type McpServer = Resource<
  TypeId,
  McpServerProps,
  McpServerAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **AI Controls MCP server** — an upstream MCP
 * endpoint registered on the account so its tools and prompts can be
 * discovered, governed, and exposed to users through an MCP portal.
 *
 * Use {@link McpPortal} to create the gateway. Creating a server does not
 * attach it to a portal; portal membership is managed outside Alchemy.
 *
 * The product surface is in beta and requires the AI Controls
 * entitlement; accounts without it receive the typed `Forbidden` error
 * on all writes. The upstream `hostname` and `authType` are create-only
 * on the API — changing either triggers a delete-first replacement.
 * Credentials are write-only: the API never returns them, so a rotation
 * is detected by comparing against the previously deployed value.
 * Existing servers without saved stack state require explicit adoption;
 * their IDs alone do not prove ownership.
 *
 * ### Registering an MCP server
 * **Example:** Public server without authentication
 * ```typescript
 * const docs = yield* Cloudflare.Access.McpServer("CloudflareDocs", {
 *   hostname: "https://docs.mcp.cloudflare.com/mcp",
 *   authType: "unauthenticated",
 * });
 * ```
 *
 * **Example:** Server behind a static bearer token
 * ```typescript
 * const internal = yield* Cloudflare.Access.McpServer("InternalTools", {
 *   hostname: "https://mcp.internal.example.com/mcp",
 *   authType: "bearer",
 *   authCredentials: yield* Config.Redacted("MCP_BEARER_TOKEN"),
 *   description: "Internal engineering tools",
 *   secureWebGateway: true,
 * });
 * ```
 *
 * **Example:** Server protected by a Cloudflare Access service token
 * ```typescript
 * const token = yield* Cloudflare.Access.ServiceToken("McpToken", {});
 *
 * const guarded = yield* Cloudflare.Access.McpServer("GuardedTools", {
 *   hostname: "https://mcp.example.com/mcp",
 *   authType: "bearer",
 *   authCredentials: Output.all(token.clientId, token.clientSecret).pipe(
 *     Output.map(([clientId, clientSecret]) =>
 *       Redacted.make(JSON.stringify({
 *         headers: {
 *           "cf-access-client-id": clientId,
 *           "cf-access-client-secret": Redacted.value(clientSecret!),
 *         },
 *       })),
 *     ),
 *   ),
 * });
 * ```
 *
 * ### Governing capabilities
 * **Example:** Disable one tool and rename another
 * ```typescript
 * const curated = yield* Cloudflare.Access.McpServer("Curated", {
 *   hostname: "https://docs.mcp.cloudflare.com/mcp",
 *   authType: "unauthenticated",
 *   updatedTools: [
 *     { name: "migrate_pages_to_workers_guide", enabled: false },
 *     { name: "search_cloudflare_documentation", alias: "search_docs" },
 *   ],
 * });
 * ```
 *
 * **Example:** Register without an explicit capability sync
 * ```typescript
 * const deferred = yield* Cloudflare.Access.McpServer("Deferred", {
 *   hostname: "https://mcp.example.com/mcp",
 *   authType: "bearer",
 *   authCredentials: yield* Config.Redacted("MCP_BEARER_TOKEN"),
 *   sync: false,
 * });
 * ```
 *
 * ### Adopting an existing server
 * **Example:** Take ownership of a server registered outside Alchemy
 * ```typescript
 * const server = yield* Cloudflare.Access.McpServer("Existing", {
 *   serverId: "existing-server",
 *   hostname: "https://mcp.example.com/mcp",
 *   authType: "unauthenticated",
 * }).pipe(adopt(true));
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/
 *
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 */
export const McpServer = Resource<McpServer>(TypeId);

/**
 * Returns true if the given value is an McpServer resource.
 */
export const isMcpServer = (value: unknown): value is McpServer =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const McpServerProvider = () =>
  Provider.succeed(McpServer, {
    stables: ["serverId", "accountId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection; exhaustively paginate. The list rows
      // carry the full server shape, so each maps directly into the same
      // Attributes `read` returns. Accounts without the AI Controls
      // entitlement reject the route with the typed `Forbidden` — treat
      // them as having no servers.
      return yield* zeroTrust.listAccessAiControlMcpServers
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((server) =>
                toAttributes(server, accountId),
              ),
            ),
          ),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // The server id is the API identity — changing it is a replacement.
      const oldId = output?.serverId ?? olds?.serverId;
      if (
        news.serverId !== undefined &&
        oldId !== undefined &&
        oldId !== news.serverId
      ) {
        return { action: "replace" } as const;
      }
      if (
        (output?.hostname ?? olds?.hostname) !== news.hostname ||
        (output?.authType ?? olds?.authType) !== news.authType
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // The server id is deterministic (client-supplied or derived from
      // the logical id), so a direct read covers the cold case too.
      const serverId =
        output?.serverId ?? (yield* createServerId(id, olds?.serverId));
      const observed = yield* observeServer(acct, serverId).pipe(
        // A failed create can leave props with an invalid ID but no output.
        // That generation cannot exist; let destroy recover the saved state.
        Effect.catchTag("McpServerInvalidId", (error) =>
          output === undefined ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
      if (!observed) return undefined;
      const attrs = toAttributes(observed, acct);
      // MCP servers carry no ownership tags. An ID match alone does not
      // authorize taking over a server when the stack has no saved output.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const serverId =
        output?.serverId ?? (yield* createServerId(id, news.serverId));
      const name = news.name ?? serverId;

      // 1. Observe.
      let observed = yield* observeServer(accountId, serverId);

      // 2. Ensure — immutable changes are handled by engine replacement.
      let changed = false;
      if (observed === undefined) {
        observed = yield* zeroTrust.createAccessAiControlMcpServer({
          accountId,
          id: serverId,
          authType: news.authType,
          hostname: news.hostname,
          ...mutableBody(news, name),
        });
        changed = true;
      } else {
        // 3. Sync — update only when the observed state differs. Unset
        //    optional props mean "keep the observed value". Credentials are
        //    write-only, so a rotation is detected against the previously
        //    deployed props rather than the cloud.
        const dirty =
          observed.name !== name ||
          (news.description !== undefined &&
            (observed.description || undefined) !== news.description) ||
          (news.secureWebGateway !== undefined &&
            (observed.secureWebGateway ?? false) !== news.secureWebGateway) ||
          (news.isSharedOauthCallbackEnabled !== undefined &&
            (observed.isSharedOauthCallbackEnabled ?? false) !==
              news.isSharedOauthCallbackEnabled) ||
          (news.updatedTools !== undefined &&
            !overridesEqual(observed.updatedTools, news.updatedTools)) ||
          (news.updatedPrompts !== undefined &&
            !overridesEqual(observed.updatedPrompts, news.updatedPrompts)) ||
          secretRotated(news.authCredentials, olds?.authCredentials) ||
          secretRotated(news.clientSecret, olds?.clientSecret);
        if (dirty) {
          observed = yield* zeroTrust.updateAccessAiControlMcpServer({
            accountId,
            id: serverId,
            ...mutableBody(news, name),
          });
          changed = true;
        }
      }

      // 4. Capability sync — best effort after a configuration change or
      //    when sync is enabled, and never while an administrator still
      //    has to complete the OAuth flow.
      //    Upstream discovery problems come back in the response body
      //    (`status`/`error`) and are matched as typed McpServerSyncFailure errors.
      if (
        (changed || olds?.sync === false) &&
        news.sync !== false &&
        observed.authenticationStatus !== "required"
      ) {
        yield* zeroTrust
          .syncAccessAiControlMcpServer({ accountId, id: serverId })
          .pipe(
            Effect.catchTag("McpServerSyncFailure", (error) =>
              Effect.logDebug(
                `capability sync for MCP server ${serverId} failed`,
                error.body,
              ),
            ),
          );
        // 5. Return — re-read so the discovered capabilities are reported.
        observed = (yield* observeServer(accountId, serverId)) ?? observed;
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessAiControlMcpServer({
          accountId: output.accountId,
          id: output.serverId,
        })
        .pipe(Effect.catchTag("McpServerNotFound", () => Effect.void));
    }),
  });

/**
 * Structural shape of a capability override as returned by the API.
 */
type ObservedOverride = {
  name: string;
  alias?: string | null;
  description?: string | null;
  enabled?: boolean | null;
};

/**
 * Structural shape shared by create/read/update/list responses.
 */
type ObservedServer = zeroTrust.ReadAccessAiControlMcpServerResponse;

/**
 * Read a server by id, mapping "gone" to `undefined`.
 */
const observeServer = (accountId: string, id: string) =>
  zeroTrust
    .readAccessAiControlMcpServer({ accountId, id })
    .pipe(
      Effect.catchTag("McpServerNotFound", () => Effect.succeed(undefined)),
    );

const createServerId = (id: string, serverId: string | undefined) =>
  Effect.gen(function* () {
    return (
      serverId ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 32 }))
    );
  });

/**
 * The request members shared by create and update, derived from the
 * desired props. Unset optional props are omitted so the API keeps (or
 * defaults) the server-side value.
 */
const mutableBody = (news: McpServerProps, name: string) => ({
  name,
  ...(news.description !== undefined ? { description: news.description } : {}),
  ...(news.secureWebGateway !== undefined
    ? { secureWebGateway: news.secureWebGateway }
    : {}),
  ...(news.isSharedOauthCallbackEnabled !== undefined
    ? { isSharedOauthCallbackEnabled: news.isSharedOauthCallbackEnabled }
    : {}),
  ...(news.updatedTools !== undefined
    ? { updatedTools: news.updatedTools }
    : {}),
  ...(news.updatedPrompts !== undefined
    ? { updatedPrompts: news.updatedPrompts }
    : {}),
  ...(news.authCredentials !== undefined
    ? { authCredentials: Redacted.value(news.authCredentials) }
    : {}),
  ...(news.clientSecret !== undefined
    ? { clientSecret: Redacted.value(news.clientSecret) }
    : {}),
});

/**
 * A write-only secret changed when it is set and differs from what was
 * last deployed (including the first time it is set).
 */
const secretRotated = (
  desired: Redacted.Redacted<string> | undefined,
  previous: Redacted.Redacted<string> | undefined,
): boolean =>
  desired !== undefined &&
  (previous === undefined ||
    Redacted.value(previous) !== Redacted.value(desired));

/**
 * Drop null/undefined members so API echoes and desired overrides compare
 * structurally.
 */
const normalizeOverride = (
  override: ObservedOverride,
): McpServerCapabilityOverride => ({
  name: override.name,
  ...(override.alias != null ? { alias: override.alias } : {}),
  ...(override.description != null
    ? { description: override.description }
    : {}),
  ...(override.enabled != null ? { enabled: override.enabled } : {}),
});

const normalizeOverrides = (
  overrides: ReadonlyArray<ObservedOverride> | null | undefined,
): McpServerCapabilityOverride[] => (overrides ?? []).map(normalizeOverride);

const overridesEqual = (
  observed: ReadonlyArray<ObservedOverride> | null | undefined,
  desired: ReadonlyArray<ObservedOverride>,
): boolean => {
  const byName = (
    a: McpServerCapabilityOverride,
    b: McpServerCapabilityOverride,
  ) => a.name.localeCompare(b.name);
  return (
    JSON.stringify(normalizeOverrides(observed).sort(byName)) ===
    JSON.stringify(normalizeOverrides(desired).sort(byName))
  );
};

const toAttributes = (
  server: ObservedServer,
  accountId: string,
): McpServerAttributes => ({
  serverId: server.id,
  accountId,
  name: server.name,
  hostname: server.hostname,
  authType: server.authType,
  description: server.description || undefined,
  secureWebGateway: server.secureWebGateway ?? false,
  isSharedOauthCallbackEnabled: server.isSharedOauthCallbackEnabled ?? false,
  updatedTools: normalizeOverrides(server.updatedTools),
  updatedPrompts: normalizeOverrides(server.updatedPrompts),
  tools: Array.from(server.tools ?? []),
  prompts: Array.from(server.prompts ?? []),
  status: server.status ?? undefined,
  authenticationStatus: server.authenticationStatus ?? undefined,
  error: server.error || undefined,
  lastSynced: server.lastSynced ?? undefined,
  lastSuccessfulSync: server.lastSuccessfulSync ?? undefined,
  createdAt: server.createdAt ?? undefined,
});
