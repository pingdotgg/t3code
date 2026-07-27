import * as AWS from "@/AWS";
import { DhcpOptions, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class DhcpOptionsStillExists extends Data.TaggedError(
  "DhcpOptionsStillExists",
) {}

const assertDeleted = Effect.fn(function* (dhcpOptionsId: string) {
  yield* EC2.describeDhcpOptions({ DhcpOptionsIds: [dhcpOptionsId] }).pipe(
    Effect.flatMap((r) =>
      (r.DhcpOptions?.length ?? 0) === 0
        ? Effect.void
        : Effect.fail(new DhcpOptionsStillExists()),
    ),
    Effect.retry({
      while: (e) => e instanceof DhcpOptionsStillExists,
      schedule: Schedule.max([Schedule.exponential(300), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidDhcpOptionID.NotFound", () => Effect.void),
    Effect.catchTag("InvalidDhcpOptionsID.NotFound", () => Effect.void),
  );
});

test.provider(
  "create DHCP options set, associate to VPC, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpc, dhcp } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DhcpVpc", { cidrBlock: "10.60.0.0/16" });
          const dhcp = yield* DhcpOptions("Dhcp", {
            domainName: "corp.internal",
            domainNameServers: ["AmazonProvidedDNS"],
            netbiosNodeType: "2",
            vpcId: vpc.vpcId,
          });
          return { vpc, dhcp };
        }),
      );

      expect(dhcp.dhcpOptionsId).toMatch(/^dopt-/);
      expect(dhcp.vpcId).toEqual(vpc.vpcId);

      // Verify out-of-band: the options set exists with the domain config.
      const described = yield* EC2.describeDhcpOptions({
        DhcpOptionsIds: [dhcp.dhcpOptionsId],
      });
      const opts = described.DhcpOptions?.[0];
      expect(opts?.DhcpOptionsId).toEqual(dhcp.dhcpOptionsId);
      const domainNameConfig = opts?.DhcpConfigurations?.find(
        (c) => c.Key === "domain-name",
      );
      expect(domainNameConfig?.Values?.[0]?.Value).toEqual("corp.internal");

      // Verify the VPC points at the options set.
      const vpcs = yield* EC2.describeVpcs({ VpcIds: [vpc.vpcId] });
      expect(vpcs.Vpcs?.[0]?.DhcpOptionsId).toEqual(dhcp.dhcpOptionsId);

      yield* stack.destroy();
      yield* assertDeleted(dhcp.dhcpOptionsId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed DHCP options set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { dhcp } = yield* stack.deploy(
        Effect.gen(function* () {
          const dhcp = yield* DhcpOptions("ListDhcp", {
            domainNameServers: ["AmazonProvidedDNS"],
          });
          return { dhcp };
        }),
      );

      const provider = yield* Provider.findProvider(DhcpOptions);
      const all = yield* provider.list();
      expect(all.some((x) => x.dhcpOptionsId === dhcp.dhcpOptionsId)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertDeleted(dhcp.dhcpOptionsId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
