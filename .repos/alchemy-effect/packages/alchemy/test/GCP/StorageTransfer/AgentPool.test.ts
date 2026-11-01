import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
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
  storagetransfer.getProjectsAgentPools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an agent pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.StorageTransfer.AgentPool("OnPrem", {
            displayName: "warehouse scanners",
          });
        }),
      );

      expect(created.agentPoolId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${created.project}/agentPools/${created.agentPoolId}`,
      );
      expect(created.displayName).toEqual("warehouse scanners");
      expect(created.state).toEqual("CREATED");
      expect(created.bandwidthLimit).toBeUndefined();

      const fetched = yield* storagetransfer.getProjectsAgentPools({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("warehouse scanners");
      expect(fetched.state).toEqual("CREATED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.StorageTransfer.AgentPool("OnPrem", {
            agentPoolId: created.agentPoolId,
            displayName: "warehouse scanners v2",
            bandwidthLimit: { limitMbps: "120" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.agentPoolId).toEqual(created.agentPoolId);
      expect(updated.displayName).toEqual("warehouse scanners v2");
      expect(updated.bandwidthLimit).toEqual({ limitMbps: "120" });

      const fetchedUpdate = yield* storagetransfer.getProjectsAgentPools({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toContain("warehouse scanners v2");
      expect(fetchedUpdate.bandwidthLimit?.limitMbps).toEqual("120");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
    timeout: 90_000,
  },
);
