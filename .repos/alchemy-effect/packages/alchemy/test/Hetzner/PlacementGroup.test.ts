import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = Hetzner.waitUntilPlacementGroupGone;

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a placement group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PlacementGroup("Web", {
            type: "spread",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.type).toEqual("spread");
      expect(created.created).toEqual(expect.any(String));
      expect(created.servers).toEqual([]);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.placementGroups.getPlacementGroup({
        id: created.id,
      });
      expect(fetched.placement_group.id).toEqual(created.id);
      expect(fetched.placement_group.name).toEqual(created.name);
      expect(fetched.placement_group.type).toEqual("spread");
      expect(fetched.placement_group.labels.env).toEqual("test");
      expect(fetched.placement_group.labels["alchemy.id"]).toBeDefined();
      expect(fetched.placement_group.servers).toEqual([]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PlacementGroup("Web", {
            name: `${created.name.slice(0, 55)}-renamed`,
            type: "spread",
            labels: { env: "prod", role: "web" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.type).toEqual("spread");
      expect(updated.name).toEqual(`${created.name.slice(0, 55)}-renamed`);
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });

      const refetched = yield* Services.placementGroups.getPlacementGroup({
        id: updated.id,
      });
      expect(refetched.placement_group.name).toEqual(updated.name);
      expect(refetched.placement_group.labels.env).toEqual("prod");
      expect(refetched.placement_group.labels.role).toEqual("web");
      expect(refetched.placement_group.labels["alchemy.id"]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed placement group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.PlacementGroup("ListGroup", {
            type: "spread",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.PlacementGroup);
      const all = yield* provider.list();
      const found = all.find((group) => group.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.type).toEqual("spread");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
