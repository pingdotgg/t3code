import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic identifiers — the portal id is the API identity, so reruns
// converge on the same portal instead of leaking. The two cases run
// concurrently, so they MUST use distinct portal ids AND distinct hostnames:
// a hostname is a per-account unique constraint, so a shared hostname makes the
// two deploys race on "This hostname is already in use in a different MCP
// Portal".
const PORTAL_ID = "alchemy-test-mcp-portal";
const HOSTNAME = "alchemy-test-mcp.alchemy-test-2.us";
const LIST_PORTAL_ID = "alchemy-test-mcp-portal-list";
const LIST_HOSTNAME = "alchemy-test-mcp-list.alchemy-test-2.us";

// Read a portal out-of-band, mapping "gone" to undefined.
const getLivePortal = (accountId: string, id: string) =>
  zeroTrust
    .readAccessAiControlMcpPortal({ accountId, id })
    .pipe(
      Effect.catchTag("McpPortalNotFound", () => Effect.succeed(undefined)),
    );

// Delete every portal currently occupying `hostname`, regardless of its portal
// id. A per-stack `destroy()` only removes the portal tracked under this
// stack's logical id, so an orphan left by a previously crashed run keeps the
// hostname (a per-account unique constraint) reserved and the next create
// fails with `McpPortalHostnameInUse`. Sweeping by hostname makes the suite
// self-healing and leaves no dangling resources behind.
const cleanupPortalsByHostname = (accountId: string, hostname: string) =>
  zeroTrust.listAccessAiControlMcpPortals.pages({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) =>
        (page.result ?? []).filter((p) => p.hostname === hostname),
      ),
    ),
    Effect.flatMap((portals) =>
      Effect.forEach(portals, (p) =>
        zeroTrust
          .deleteAccessAiControlMcpPortal({ accountId, id: p.id })
          .pipe(Effect.catchTag("McpPortalNotFound", () => Effect.void)),
      ),
    ),
    Effect.catchTag("Forbidden", () => Effect.void),
  );

test.provider(
  "create, update in place, and destroy an MCP portal",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* cleanupPortalsByHostname(accountId, HOSTNAME);

      const portal = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpPortal("AiPortal", {
            portalId: PORTAL_ID,
            hostname: HOSTNAME,
            description: "alchemy mcp portal v1",
          });
        }),
      );

      expect(portal.portalId).toEqual(PORTAL_ID);
      expect(portal.accountId).toEqual(accountId);
      expect(portal.hostname).toEqual(HOSTNAME);
      expect(portal.name).toEqual(PORTAL_ID);
      expect(portal.description).toEqual("alchemy mcp portal v1");
      // Observed server-side default (no allowCodeMode requested).
      expect(portal.allowCodeMode).toEqual(true);
      expect(portal.secureWebGateway).toEqual(false);

      const live = yield* getLivePortal(accountId, PORTAL_ID);
      expect(live?.id).toEqual(PORTAL_ID);
      expect(live?.hostname).toEqual(HOSTNAME);

      // Name + description update converges in place — same portal id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpPortal("AiPortal", {
            portalId: PORTAL_ID,
            name: "Alchemy AI Portal",
            hostname: HOSTNAME,
            description: "alchemy mcp portal v2",
            secureWebGateway: true,
          });
        }),
      );
      expect(updated.portalId).toEqual(PORTAL_ID);
      expect(updated.name).toEqual("Alchemy AI Portal");
      expect(updated.description).toEqual("alchemy mcp portal v2");
      expect(updated.secureWebGateway).toEqual(true);

      const liveUpdated = yield* getLivePortal(accountId, PORTAL_ID);
      expect(liveUpdated?.name).toEqual("Alchemy AI Portal");
      expect(liveUpdated?.secureWebGateway).toEqual(true);

      // No-op redeploy keeps the same portal without drift.
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpPortal("AiPortal", {
            portalId: PORTAL_ID,
            name: "Alchemy AI Portal",
            hostname: HOSTNAME,
            description: "alchemy mcp portal v2",
            secureWebGateway: true,
          });
        }),
      );
      expect(noop.portalId).toEqual(PORTAL_ID);

      yield* stack.destroy();

      const afterDestroy = yield* getLivePortal(accountId, PORTAL_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Canonical `list()` test (account collection): deploy a portal, then resolve
// the provider via the typed helper and assert the deployed portal appears in
// the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed MCP portal",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* cleanupPortalsByHostname(accountId, LIST_HOSTNAME);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpPortal("ListPortal", {
            portalId: LIST_PORTAL_ID,
            hostname: LIST_HOSTNAME,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.McpPortal,
      );
      const all = yield* provider.list();

      expect(all.some((p) => p.portalId === deployed.portalId)).toBe(true);

      yield* stack.destroy();

      const afterDestroy = yield* getLivePortal(accountId, LIST_PORTAL_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
