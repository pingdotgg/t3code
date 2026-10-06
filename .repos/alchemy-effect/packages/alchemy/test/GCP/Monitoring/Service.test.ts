import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
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
  monitoring.getServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a monitoring service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.Service("Checkout", {
            displayName: "Checkout",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/services/");
      expect(created.serviceId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("Checkout");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.custom).toEqual({});

      const fetched = yield* monitoring.getServices({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("Checkout");
      expect(fetched.userLabels?.env).toEqual("test");
      expect(
        Object.keys(fetched.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);
      expect(fetched.custom).toEqual({});

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.Service("Checkout", {
            serviceId: created.serviceId,
            displayName: "Checkout v2",
            labels: { env: "prod", team: "payments" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Checkout v2");
      expect(updated.labels).toMatchObject({ env: "prod", team: "payments" });

      const fetchedUpdate = yield* monitoring.getServices({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Checkout v2");
      expect(fetchedUpdate.userLabels?.env).toEqual("prod");
      expect(fetchedUpdate.userLabels?.team).toEqual("payments");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:monitoring", "live"],
    timeout: 90_000,
  },
);
