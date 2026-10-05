import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsActiveDirectories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsActiveDirectories on a missing directory fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsActiveDirectories({
          name: `projects/${project}/locations/us-central1/activeDirectories/alchemy-netapp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsActiveDirectories({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.activeDirectories ?? []).map((item) => item.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/activeDirectories/alchemy-netapp-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an active directory",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.ActiveDirectory("Corp", {
            domain: "ad.example.com",
            dns: "10.0.0.2",
            netBiosPrefix: "netapp",
            username: "admin",
            password: "NotARealPassword1",
            description: "alchemy-test-ad",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/activeDirectories/");
      expect(created.domain).toEqual("ad.example.com");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsActiveDirectories({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.domain).toEqual("ad.example.com");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.ActiveDirectory("Corp", {
            activeDirectoryId: created.activeDirectoryId,
            domain: "ad.example.com",
            dns: "10.0.0.2",
            netBiosPrefix: "netapp",
            username: "admin",
            description: "alchemy-prod-ad",
            labels: { env: "prod", role: "ad" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-ad");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ad" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 120_000 },
);
