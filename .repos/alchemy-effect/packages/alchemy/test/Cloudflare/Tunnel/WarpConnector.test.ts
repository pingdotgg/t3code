import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Read a WARP Connector tunnel out-of-band, mapping "gone" (TunnelNotFound)
// and soft-deleted tunnels to undefined.
const getLiveConnector = (accountId: string, tunnelId: string) =>
  zeroTrust.getTunnelWarpConnector({ accountId, tunnelId }).pipe(
    Effect.map((t) => (t.deletedAt ? undefined : t)),
    Effect.catchTag("TunnelNotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "create, rename by replacement, and destroy a WARP Connector tunnel",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const connector = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel.WarpConnector("SiteA", {
            name: "alchemy-test-warp-connector",
          }).pipe(adopt(true));
        }),
      );

      expect(connector.tunnelId).toBeDefined();
      expect(connector.accountId).toEqual(accountId);
      expect(connector.name).toEqual("alchemy-test-warp-connector");
      // The connector token is returned redacted and non-empty.
      expect(Redacted.value(connector.token).length).toBeGreaterThan(0);
      // A never-joined connector only ever shows API-visible CRUD state —
      // do not wait for connection states; assert the record exists.
      const live = yield* getLiveConnector(accountId, connector.tunnelId);
      expect(live?.id).toEqual(connector.tunnelId);
      expect(live?.name).toEqual("alchemy-test-warp-connector");

      // Cloudflare returns TunnelNotFound from the documented PATCH endpoint
      // for a live connector, so changing the name replaces the tunnel.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel.WarpConnector("SiteA", {
            name: "alchemy-test-warp-connector-v2",
          }).pipe(adopt(true));
        }),
      );
      expect(renamed.tunnelId).not.toEqual(connector.tunnelId);
      expect(renamed.name).toEqual("alchemy-test-warp-connector-v2");

      const renamedLive = yield* getLiveConnector(accountId, renamed.tunnelId);
      expect(renamedLive?.name).toEqual("alchemy-test-warp-connector-v2");

      yield* stack.destroy();

      // Cloudflare soft-deletes tunnels; gone = 404 or deletedAt set.
      const afterDestroy = yield* getLiveConnector(accountId, renamed.tunnelId);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Canonical `list()` test (account collection): deploy a WARP Connector
// tunnel, resolve the provider via the typed `Provider.findProvider`, and
// assert the deployed tunnel appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed WARP Connector tunnel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const connector = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel.WarpConnector("ListSite", {
            name: "alchemy-test-warp-connector-list",
          }).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Tunnel.WarpConnector,
      );
      const all = yield* provider.list();

      const found = all.find((t) => t.tunnelId === connector.tunnelId);
      expect(found).toBeDefined();
      expect(found?.name).toEqual("alchemy-test-warp-connector-list");
      expect(found?.accountId).toEqual(connector.accountId);
      expect(Redacted.value(found!.token).length).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
