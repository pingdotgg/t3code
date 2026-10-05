import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, networkEndpointGroup: string) =>
  compute
    .getGlobalNetworkEndpointGroups({
      project,
      networkEndpointGroup,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, replace, and delete a global network endpoint group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalNetworkEndpointGroup("Neg", {
            networkEndpointType: "INTERNET_FQDN_PORT",
            defaultPort: 443,
            description: "internet neg",
            networkEndpoints: [{ fqdn: "www.example.com", port: 443 }],
          });
        }),
      );

      expect(created.networkEndpointGroupName).toEqual(expect.any(String));
      expect(created.networkEndpointType).toEqual("INTERNET_FQDN_PORT");
      expect(created.description).toEqual("internet neg");
      expect(created.defaultPort).toEqual(443);

      const fetched = yield* compute.getGlobalNetworkEndpointGroups({
        project: created.project,
        networkEndpointGroup: created.networkEndpointGroupName,
      });
      expect(fetched.name).toEqual(created.networkEndpointGroupName);
      expect(fetched.networkEndpointType).toEqual("INTERNET_FQDN_PORT");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("internet neg");
      expect(fetched.defaultPort).toEqual(443);
      expect(fetched.size).toEqual(1);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalNetworkEndpointGroup("Neg", {
            networkEndpointGroupName: created.networkEndpointGroupName,
            networkEndpointType: "INTERNET_FQDN_PORT",
            defaultPort: 443,
            description: "www backends",
            networkEndpoints: [{ fqdn: "www.example.com", port: 443 }],
          });
        }),
      );

      expect(replaced.networkEndpointGroupName).toEqual(
        created.networkEndpointGroupName,
      );
      expect(replaced.networkEndpointType).toEqual("INTERNET_FQDN_PORT");
      expect(replaced.description).toEqual("www backends");
      expect(replaced.defaultPort).toEqual(443);
      expect(replaced.networkEndpointGroupId).not.toEqual(
        created.networkEndpointGroupId,
      );

      const fetchedReplaced = yield* compute.getGlobalNetworkEndpointGroups({
        project: replaced.project,
        networkEndpointGroup: replaced.networkEndpointGroupName,
      });
      expect(fetchedReplaced.description).toContain("[alchemy ");
      expect(fetchedReplaced.description).toContain("www backends");
      expect(fetchedReplaced.defaultPort).toEqual(443);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.networkEndpointGroupName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
