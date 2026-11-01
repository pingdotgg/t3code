import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networkservices.getProjectsLocationsAgentGateways({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentGateways on a missing gateway fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsAgentGateways({
          name: `projects/${project}/locations/us-central1/agentGateways/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

// Agent gateway create + update + delete takes ~7 minutes.
test.provider.skipIf(!process.env.GCP_TEST_SLOW || !!process.env.FAST)(
  "create, update, and delete an agent gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.AgentGateway("Agents", {
            location: "us-central1",
            description: "agent gateway a",
            labels: { env: "test" },
            googleManaged: { governedAccessPath: "AGENT_TO_ANYWHERE" },
          });
        }),
      );

      expect(created.name).toContain("/agentGateways/");
      expect(created.agentGatewayId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("agent gateway a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.googleManaged?.governedAccessPath).toEqual(
        "AGENT_TO_ANYWHERE",
      );
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsAgentGateways({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("agent gateway a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.AgentGateway("Agents", {
            agentGatewayId: created.agentGatewayId,
            location: "us-central1",
            description: "agent gateway b",
            labels: { env: "prod", role: "agents" },
            googleManaged: { governedAccessPath: "AGENT_TO_ANYWHERE" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("agent gateway b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "agents" });

      const refetched =
        yield* networkservices.getProjectsLocationsAgentGateways({
          name: created.name,
        });
      expect(refetched.description).toEqual("agent gateway b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("agents");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 900_000,
  },
);
