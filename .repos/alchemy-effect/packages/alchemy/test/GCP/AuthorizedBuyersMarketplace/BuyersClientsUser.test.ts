import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  lifecycleParent,
  logLevel,
  probeName,
  probeParent,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getBuyersClientsUsers without the Marketplace OAuth scope fails with AuthorizedBuyersScopeInsufficient",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        marketplace.getBuyersClientsUsers({ name: probeName }),
      );
      expect(error._tag).toEqual("AuthorizedBuyersScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:authorizedbuyersmarketplace", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createBuyersClientsUsers without the Marketplace OAuth scope fails with AuthorizedBuyersScopeInsufficient",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        marketplace.createBuyersClientsUsers({
          parent: probeParent,
          body: { email: "alchemy-abm-probe@example.com" },
        }),
      );
      expect(error._tag).toEqual("AuthorizedBuyersScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:authorizedbuyersmarketplace", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST || lifecycleParent === undefined)(
  "create, update, and delete a client user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = lifecycleParent!;
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AuthorizedBuyersMarketplace.BuyersClientsUser(
            "Analyst",
            { parent, email: "analyst@example.com" },
          );
        }),
      );

      expect(created.name).toContain("/users/");
      expect(created.parent).toEqual(parent);
      expect(created.email).toEqual("analyst@example.com");
      expect(created.userId.length).toBeGreaterThan(0);
      expect(["INVITED", "ACTIVE", "INACTIVE"]).toContain(created.state);

      const fetched = yield* marketplace.getBuyersClientsUsers({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toEqual("analyst@example.com");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AuthorizedBuyersMarketplace.BuyersClientsUser(
            "Analyst",
            {
              parent: created.parent,
              email: "analyst@example.com",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.email).toEqual("analyst@example.com");
      expect(updated.userId).toEqual(created.userId);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AuthorizedBuyersMarketplace.BuyersClientsUser(
            "Analyst",
            {
              parent: created.parent,
              email: "analyst-v2@example.com",
            },
          );
        }),
      );

      expect(replaced.email).toEqual("analyst-v2@example.com");
      expect(replaced.parent).toEqual(created.parent);

      const fetchedReplace = yield* marketplace.getBuyersClientsUsers({
        name: replaced.name,
      });
      expect(fetchedReplace.email).toEqual("analyst-v2@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:authorizedbuyersmarketplace", "live"],
    timeout: 90_000,
  },
);
