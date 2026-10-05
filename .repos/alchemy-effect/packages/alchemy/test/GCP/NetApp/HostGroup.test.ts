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

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsHostGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsHostGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsHostGroups({
          name: `projects/${project}/locations/us-central1/hostGroups/alchemy-netapp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsHostGroups({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.hostGroups ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/hostGroups/alchemy-netapp-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a host group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.HostGroup("Initiators", {
            hosts: ["iqn.1993-08.org.debian:01:alchemy"],
            description: "alchemy-test-hosts",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/hostGroups/");
      expect(created.hosts).toContain("iqn.1993-08.org.debian:01:alchemy");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsHostGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.HostGroup("Initiators", {
            hostGroupId: created.hostGroupId,
            hosts: [
              "iqn.1993-08.org.debian:01:alchemy",
              "iqn.1993-08.org.debian:01:alchemy2",
            ],
            description: "alchemy-prod-hosts",
            labels: { env: "prod", role: "iscsi" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-hosts");
      expect(updated.labels).toMatchObject({ env: "prod", role: "iscsi" });
      expect(updated.hosts).toHaveLength(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 120_000 },
);
