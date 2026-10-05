import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/gcp/dns_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, policyName: string) =>
  dns.getPolicies({ project, policy: policyName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const lastSegment = (url: string) => url.split("/").pop() ?? url;

test.provider(
  "create, update, replace, and delete a DNS server policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.Policy("DnsPolicy", {
            description: "alchemy test dns policy",
            enableLogging: true,
            networks: [vpc.networkName],
          });
          return { vpc, policy };
        }),
      );

      expect(created.policy.policyName).toEqual(expect.any(String));
      expect(created.policy.description).toEqual("alchemy test dns policy");
      expect(created.policy.enableLogging).toEqual(true);
      expect(created.policy.enableInboundForwarding).toEqual(false);
      expect(created.policy.enableDns64).toEqual(false);
      expect(created.policy.networks.map(lastSegment)).toContain(
        created.vpc.networkName,
      );

      const fetched = yield* dns.getPolicies({
        project: created.policy.project,
        policy: created.policy.policyName,
      });
      expect(fetched.name).toEqual(created.policy.policyName);
      expect(fetched.enableLogging).toEqual(true);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy test dns policy");
      expect(
        (fetched.networks ?? []).map((network) =>
          lastSegment(network.networkUrl ?? ""),
        ),
      ).toContain(created.vpc.networkName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.Policy("DnsPolicy", {
            policyName: created.policy.policyName,
            description: "updated alchemy test dns policy",
            enableLogging: false,
            networks: [vpc.networkName],
          });
          return { vpc, policy };
        }),
      );

      expect(updated.policy.policyName).toEqual(created.policy.policyName);
      expect(updated.policy.description).toEqual(
        "updated alchemy test dns policy",
      );
      expect(updated.policy.enableLogging).toEqual(false);

      const fetchedUpdate = yield* dns.getPolicies({
        project: created.policy.project,
        policy: created.policy.policyName,
      });
      expect(fetchedUpdate.enableLogging).toEqual(false);
      expect(fetchedUpdate.description).toContain(
        "updated alchemy test dns policy",
      );

      const replacedName = `r${created.policy.policyName}`.slice(0, 63);
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
          });
          const policy = yield* GCP.DNS.Policy("DnsPolicy", {
            policyName: replacedName,
            description: "replaced alchemy test dns policy",
            enableLogging: true,
            networks: [vpc.networkName],
          });
          return { vpc, policy };
        }),
      );

      expect(replaced.policy.policyName).toEqual(replacedName);
      expect(replaced.policy.enableLogging).toEqual(true);
      expect(replaced.policy.description).toEqual(
        "replaced alchemy test dns policy",
      );

      const previousGone = yield* waitUntilGone(
        created.policy.project,
        created.policy.policyName,
      );
      expect(previousGone).toEqual("gone");

      const fetchedReplacement = yield* dns.getPolicies({
        project: created.policy.project,
        policy: replacedName,
      });
      expect(fetchedReplacement.name).toEqual(replacedName);
      expect(fetchedReplacement.enableLogging).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.policy.project, replacedName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  { tags: ["provider:gcp", "provider:gcp:dns", "live"], timeout: 120_000 },
);
