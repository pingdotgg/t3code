import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
import { LogGroup } from "@/AWS/Logs";
import {
  Firewall,
  FirewallPolicy,
  LoggingConfiguration,
} from "@/AWS/NetworkFirewall";
import * as Test from "@/Test/Alchemy";
import * as nfw from "@distilled.cloud/aws/network-firewall";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tags this provider's read/delete paths depend on.
test.provider(
  "describeFirewall on a nonexistent firewall fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nfw.describeFirewall({
          FirewallName: "alchemy-nonexistent-nfw-firewall-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "describeLoggingConfiguration on a nonexistent firewall fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nfw.describeLoggingConfiguration({
          FirewallName: "alchemy-nonexistent-nfw-firewall-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertFirewallGone = (name: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      nfw.describeFirewall({ FirewallName: name }),
    );
    if (error._tag !== "ResourceNotFoundException") {
      return yield* Effect.fail(
        new Error(`firewall '${name}' still exists (${error._tag})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// A firewall takes ~5-10 minutes to provision its endpoints and a similar
// window to deprovision on delete. The full lifecycle is gated behind
// AWS_TEST_NETWORKFIREWALL=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_NETWORKFIREWALL)(
  "create firewall with logging configuration, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { firewall, logging, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("Vpc", {
            cidrBlock: "10.77.0.0/16",
            tags: { fixture: "nfw-firewall" },
          });
          const subnet = yield* Subnet("FirewallSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.77.1.0/24",
            tags: { fixture: "nfw-firewall" },
          });
          const policy = yield* FirewallPolicy("Policy", {
            firewallPolicy: {
              StatelessDefaultActions: ["aws:pass"],
              StatelessFragmentDefaultActions: ["aws:pass"],
            },
          });
          const firewall = yield* Firewall("Firewall", {
            firewallPolicyArn: policy.firewallPolicyArn,
            vpcId: vpc.vpcId,
            subnetMappings: [{ SubnetId: subnet.subnetId }],
            description: "alchemy network firewall test",
            tags: { fixture: "nfw-firewall" },
          });
          const logGroup = yield* LogGroup("FlowLogs", {
            retention: "1 day",
          });
          const logging = yield* LoggingConfiguration("Logging", {
            firewallArn: firewall.firewallArn,
            logDestinationConfigs: [
              {
                LogType: "FLOW",
                LogDestinationType: "CloudWatchLogs",
                LogDestination: { logGroup: logGroup.logGroupName },
              },
            ],
          });
          return { firewall, logging, policy };
        }),
      );

      expect(firewall.firewallArn).toContain(":firewall/");
      expect(firewall.firewallId).toBeDefined();
      expect(firewall.endpointIds.length).toBe(1);
      expect(firewall.endpointIds[0]).toMatch(/^vpce-/);
      expect(logging.firewallArn).toBe(firewall.firewallArn);

      // Out-of-band verification via distilled.
      const observed = yield* nfw.describeFirewall({
        FirewallName: firewall.firewallName,
      });
      expect(observed.FirewallStatus?.Status).toBe("READY");
      expect(observed.Firewall?.FirewallPolicyArn).toBe(
        policy.firewallPolicyArn,
      );

      const observedLogging = yield* nfw.describeLoggingConfiguration({
        FirewallArn: firewall.firewallArn,
      });
      expect(
        observedLogging.LoggingConfiguration?.LogDestinationConfigs?.[0]
          ?.LogType,
      ).toBe("FLOW");

      // Destroy immediately (delete waits for endpoint deprovisioning) and
      // verify the firewall is gone out-of-band.
      yield* stack.destroy();
      yield* assertFirewallGone(firewall.firewallName);
    }),
  // firewall create (~10 min) + delete (~10 min), one test.
  { timeout: 2_400_000 },
);
