import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Access.McpPortal" as const;
type TypeId = typeof TypeId;

export interface McpPortalProps {
  /**
   * The client-supplied portal identifier. Immutable — changing it
   * triggers a replacement. If omitted, a deterministic id is generated
   * from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  portalId?: string;
  /**
   * Display name of the portal. If omitted, the portal id is reused.
   * @default the portal id
   */
  name?: string;
  /**
   * The hostname the portal is served on. Must belong to a zone on the
   * account.
   */
  hostname: string;
  /**
   * Optional description of the portal.
   */
  description?: string;
  /**
   * Allow remote code execution in Dynamic Workers (beta). When omitted,
   * the server-side default applies (observed: `true`).
   */
  allowCodeMode?: boolean;
  /**
   * Route outbound MCP traffic through the Zero Trust Secure Web
   * Gateway.
   * @default false
   */
  secureWebGateway?: boolean;
}

export type McpPortalAttributes = {
  /** The portal id. */
  portalId: string;
  /** Account that owns the portal. */
  accountId: string;
  /** Observed display name. */
  name: string;
  /** Observed portal hostname. */
  hostname: string;
  /** Observed description, if any. */
  description: string | undefined;
  /** Whether Dynamic Workers code mode is allowed. */
  allowCodeMode: boolean;
  /** Whether outbound MCP traffic routes through the gateway. */
  secureWebGateway: boolean;
  /** RFC 3339 timestamp of when the portal was created, if reported. */
  createdAt: string | undefined;
};

export type McpPortal = Resource<
  TypeId,
  McpPortalProps,
  McpPortalAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **AI Controls MCP portal** — a hosted gateway
 * that aggregates MCP servers behind a single Access-protected hostname
 * so administrators can govern which AI tools and prompts are exposed to
 * users.
 *
 * The product surface is in beta and requires the AI Controls
 * entitlement; accounts without it receive the typed `Forbidden` error
 * on all writes. Attaching servers to the portal is managed out of band
 * (a future `Cloudflare.Access.McpServer` resource).
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating an MCP portal
 * @example Minimal portal
 * ```typescript
 * const portal = yield* Cloudflare.Access.McpPortal("AiPortal", {
 *   hostname: "mcp.example.com",
 * });
 * ```
 *
 * @example Portal with gateway egress
 * ```typescript
 * const portal = yield* Cloudflare.Access.McpPortal("AiPortal", {
 *   hostname: "mcp.example.com",
 *   description: "Company-approved AI tools",
 *   secureWebGateway: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/
 */
export const McpPortal = Resource<McpPortal>(TypeId);

/**
 * Returns true if the given value is an McpPortal resource.
 */
export const isMcpPortal = (value: unknown): value is McpPortal =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const McpPortalProvider = () =>
  Provider.succeed(McpPortal, {
    stables: ["portalId", "accountId", "createdAt"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection; exhaustively paginate. The list rows
      // carry the full portal shape, so each maps directly into the same
      // Attributes `read` returns. Accounts without the AI Controls
      // entitlement reject the route with the typed `Forbidden` — treat
      // them as having no portals.
      return yield* zeroTrust.listAccessAiControlMcpPortals
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((portal) =>
                toAttributes(portal, accountId),
              ),
            ),
          ),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The portal id is the API identity — changing it is a replacement.
      const oldId = output?.portalId ?? olds?.portalId;
      if (
        news.portalId !== undefined &&
        oldId !== undefined &&
        oldId !== news.portalId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // The portal id is deterministic (client-supplied or derived from
      // the logical id), so a direct read covers the cold case too.
      const portalId =
        output?.portalId ?? (yield* createPortalId(id, olds?.portalId));
      const observed = yield* observePortal(acct, portalId);
      return observed ? toAttributes(observed, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const portalId =
        output?.portalId ?? (yield* createPortalId(id, news.portalId));
      const name = news.name ?? portalId;

      // 1. Observe.
      const observed = yield* observePortal(accountId, portalId);

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* zeroTrust.createAccessAiControlMcpPortal({
          accountId,
          id: portalId,
          hostname: news.hostname,
          name,
          ...(news.description !== undefined
            ? { description: news.description }
            : {}),
          ...(news.allowCodeMode !== undefined
            ? { allowCodeMode: news.allowCodeMode }
            : {}),
          ...(news.secureWebGateway !== undefined
            ? { secureWebGateway: news.secureWebGateway }
            : {}),
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — update only when the observed state differs. Unset
      //    optional props mean "keep the observed value" (the API applies
      //    server-side defaults on create, e.g. allowCodeMode: true).
      const dirty =
        observed.name !== name ||
        observed.hostname !== news.hostname ||
        (news.description !== undefined &&
          (observed.description || undefined) !== news.description) ||
        (news.allowCodeMode !== undefined &&
          (observed.allowCodeMode ?? false) !== news.allowCodeMode) ||
        (news.secureWebGateway !== undefined &&
          (observed.secureWebGateway ?? false) !== news.secureWebGateway);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* zeroTrust.updateAccessAiControlMcpPortal({
        accountId,
        id: portalId,
        name,
        hostname: news.hostname,
        ...(news.description !== undefined
          ? { description: news.description }
          : {}),
        ...(news.allowCodeMode !== undefined
          ? { allowCodeMode: news.allowCodeMode }
          : {}),
        ...(news.secureWebGateway !== undefined
          ? { secureWebGateway: news.secureWebGateway }
          : {}),
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessAiControlMcpPortal({
          accountId: output.accountId,
          id: output.portalId,
        })
        .pipe(Effect.catchTag("McpPortalNotFound", () => Effect.void));
    }),
  });

/**
 * Structural shape shared by create/read/update responses.
 */
type ObservedPortal = {
  id: string;
  hostname: string;
  name: string;
  allowCodeMode?: boolean | null;
  createdAt?: string | null;
  description?: string | null;
  secureWebGateway?: boolean | null;
};

/**
 * Read a portal by id, mapping "gone" to `undefined`.
 */
const observePortal = (accountId: string, id: string) =>
  zeroTrust
    .readAccessAiControlMcpPortal({ accountId, id })
    .pipe(
      Effect.catchTag("McpPortalNotFound", () => Effect.succeed(undefined)),
    );

const createPortalId = (id: string, portalId: string | undefined) =>
  Effect.gen(function* () {
    return portalId ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  portal: ObservedPortal,
  accountId: string,
): McpPortalAttributes => ({
  portalId: portal.id,
  accountId,
  name: portal.name,
  hostname: portal.hostname,
  description: portal.description || undefined,
  allowCodeMode: portal.allowCodeMode ?? false,
  secureWebGateway: portal.secureWebGateway ?? false,
  createdAt: portal.createdAt ?? undefined,
});
