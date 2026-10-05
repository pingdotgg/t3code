import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
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
  scc.getProjectsMuteConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Security Command Center is not activated on the testing project (every
// call fails with ServiceDisabled). Set GCP_TEST_SECURITY_CENTER=1 on a
// project with SCC activated.
const runLifecycle = !!process.env.GCP_TEST_SECURITY_CENTER;

test.provider(
  "getProjectsMuteConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        scc.getProjectsMuteConfigs({
          name: `projects/${project}/muteConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a mute config",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.MuteConfig("Low", {
            filter: 'severity="LOW"',
            description: "mute low severity",
          });
        }),
      );

      expect(created.muteConfigId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/muteConfigs/${created.muteConfigId}`,
      );
      expect(created.filter).toEqual('severity="LOW"');
      expect(created.description).toEqual("mute low severity");

      const fetched = yield* scc.getProjectsMuteConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.filter).toEqual('severity="LOW"');

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.MuteConfig("Low", {
            muteConfigId: created.muteConfigId,
            filter: 'severity="LOW" OR severity="MEDIUM"',
            description: "mute low and medium",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual('severity="LOW" OR severity="MEDIUM"');
      expect(updated.description).toEqual("mute low and medium");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
