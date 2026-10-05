import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsAddressGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an address group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.AddressGroup("Allowlist", {
            type: "IPV4",
            capacity: 100,
            items: ["10.0.0.1"],
            description: "address group a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/addressGroups/");
      expect(created.name).toContain("/locations/global/");
      expect(created.addressGroupId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.type).toEqual("IPV4");
      expect(created.capacity).toEqual(100);
      expect(created.items).toEqual(["10.0.0.1"]);
      expect(created.description).toEqual("address group a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networksecurity.getProjectsLocationsAddressGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.items).toEqual(["10.0.0.1"]);
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.AddressGroup("Allowlist", {
            addressGroupId: created.addressGroupId,
            type: "IPV4",
            capacity: 100,
            items: ["10.0.0.1", "10.1.0.0/24"],
            description: "address group b",
            labels: { env: "prod", role: "allowlist" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("address group b");
      expect(updated.items.sort()).toEqual(["10.0.0.1", "10.1.0.0/24"].sort());
      expect(updated.labels).toMatchObject({ env: "prod", role: "allowlist" });

      const refetched =
        yield* networksecurity.getProjectsLocationsAddressGroups({
          name: created.name,
        });
      expect(refetched.description).toEqual("address group b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("allowlist");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
