import * as AWS from "@/AWS";
import {
  ConditionalForwarder,
  Directory,
  EventTopic,
} from "@/AWS/DirectoryService";
import { Topic } from "@/AWS/SNS";
import * as Test from "@/Test/Alchemy";
import * as ds from "@distilled.cloud/aws/directory-service";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "describeDirectories on a nonexistent directory fails with EntityDoesNotExistException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ds.describeDirectories({ DirectoryIds: ["d-1234567890"] }),
      );
      expect(error._tag).toBe("EntityDoesNotExistException");
    }),
);

test.provider(
  "describeConditionalForwarders on a nonexistent directory fails with EntityDoesNotExistException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ds.describeConditionalForwarders({
          DirectoryId: "d-1234567890",
          RemoteDomainNames: ["partner.alchemy-test.internal"],
        }),
      );
      expect(error._tag).toBe("EntityDoesNotExistException");
    }),
);

test.provider(
  "describeEventTopics on a nonexistent directory fails with EntityDoesNotExistException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ds.describeEventTopics({ DirectoryId: "d-1234567890" }),
      );
      expect(error._tag).toBe("EntityDoesNotExistException");
    }),
);

test.provider(
  "registerEventTopic on a nonexistent directory fails with EntityDoesNotExistException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ds.registerEventTopic({
          DirectoryId: "d-1234567890",
          TopicName: "alchemy-directory-service-missing",
        }),
      );
      expect(error._tag).toBe("EntityDoesNotExistException");
    }),
);

// Resolve the default VPC and two default-for-AZ subnets in DIFFERENT AZs —
// Directory Service launches one domain controller per subnet and requires
// exactly two subnets in distinct Availability Zones.
const defaultNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const byAz = new Map<string, string>();
  for (const subnet of subnets.Subnets ?? []) {
    if (
      subnet.SubnetId !== undefined &&
      subnet.AvailabilityZone !== undefined &&
      // Not every AZ supports every service — stick to the region's first
      // three AZs (suffix a/b/c).
      /[abc]$/.test(subnet.AvailabilityZone) &&
      !byAz.has(subnet.AvailabilityZone)
    ) {
      byAz.set(subnet.AvailabilityZone, subnet.SubnetId);
    }
  }
  const subnetIds = [...byAz.entries()]
    .sort((l, r) => l[0].localeCompare(r[0]))
    .map(([, id]) => id)
    .slice(0, 2);
  if (subnetIds.length < 2) {
    return yield* Effect.die(
      new Error("default VPC is missing subnets in two distinct AZs"),
    );
  }
  return { vpcId: vpc.vpcId, subnetIds };
});

// Deletion is verified as INITIATED (stage `Deleting`, irreversible) or
// fully gone. Full disappearance takes several more minutes server-side.
const assertDirectoryDeleting = (directoryId: string) =>
  Effect.gen(function* () {
    const stage = yield* ds
      .describeDirectories({ DirectoryIds: [directoryId] })
      .pipe(
        Effect.map(
          (r) => r.DirectoryDescriptions?.[0]?.Stage ?? ("gone" as const),
        ),
        Effect.catchTag("EntityDoesNotExistException", () =>
          Effect.succeed("gone" as const),
        ),
      );
    if (stage !== "gone" && stage !== "Deleting" && stage !== "Deleted") {
      return yield* Effect.fail(
        new Error(`directory '${directoryId}' still exists (stage: ${stage})`),
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

// A Simple AD directory takes ~10 minutes to provision (Microsoft AD takes
// 20-40) and bills hourly while it exists. The full lifecycle is gated
// behind AWS_TEST_DIRECTORY=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_DIRECTORY)(
  "create Simple AD directory, verify, update tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;
      const props = {
        name: "corp.alchemy-test.internal",
        password: Redacted.make("AlchemyTest123!"),
        size: "Small" as const,
        description: "alchemy directory-service test",
        vpcId: network.vpcId,
        subnetIds: network.subnetIds,
      };

      const buildStack = (tags: Record<string, string>) =>
        Effect.gen(function* () {
          const directory = yield* Directory("Corp", { ...props, tags });
          // Directory Service's native event mechanism: publish status
          // changes to an SNS topic.
          const topic = yield* Topic("Status", {});
          const eventTopic = yield* EventTopic("StatusTopic", {
            directoryId: directory.directoryId,
            topicName: topic.topicName,
          });
          return { directory, eventTopic };
        });

      const { directory, eventTopic } = yield* stack.deploy(
        buildStack({ fixture: "directory-service" }),
      );

      expect(directory.directoryId).toMatch(/^d-/);
      expect(directory.directoryName).toBe("corp.alchemy-test.internal");
      expect(directory.type).toBe("SimpleAD");
      expect(directory.stage).toBe("Active");
      expect(directory.size).toBe("Small");
      expect(directory.dnsIpAddrs.length).toBe(2);
      expect(directory.vpcId).toBe(network.vpcId);
      expect([...directory.subnetIds].sort()).toEqual(
        [...network.subnetIds].sort(),
      );
      expect(directory.tags.fixture).toBe("directory-service");
      expect(directory.tags["alchemy::id"]).toBeDefined();

      // Out-of-band verification via distilled.
      const described = yield* ds.describeDirectories({
        DirectoryIds: [directory.directoryId],
      });
      const observed = described.DirectoryDescriptions?.[0];
      expect(observed?.Stage).toBe("Active");
      expect(observed?.Type).toBe("SimpleAD");
      expect(observed?.Name).toBe("corp.alchemy-test.internal");

      // The EventTopic association registered the directory as a publisher
      // to the SNS topic — verify out-of-band via distilled.
      expect(eventTopic.directoryId).toBe(directory.directoryId);
      expect(eventTopic.topicArn).toBeDefined();
      expect(eventTopic.status).toBe("Registered");
      const topics = yield* ds.describeEventTopics({
        DirectoryId: directory.directoryId,
      });
      expect(topics.EventTopics?.map((topic) => topic.TopicName)).toContain(
        eventTopic.topicName,
      );

      // Tags mutate in place — a second deploy must keep the SAME directory
      // id (no replacement) and converge the tag set.
      const { directory: updated } = yield* stack.deploy(
        buildStack({ fixture: "directory-service", wave: "2" }),
      );
      expect(updated.directoryId).toBe(directory.directoryId);
      expect(updated.tags.wave).toBe("2");

      // Destroy immediately — directories bill while they exist — and
      // verify deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertDirectoryDeleting(directory.directoryId);
    }),
  // directory create (~10 min) + tag-sync deploy + delete initiation.
  { timeout: 2_400_000 },
);

// Conditional forwarders require an AWS Managed Microsoft AD directory
// (Simple AD does not support them), which takes 20-40 minutes to provision.
// Gated separately behind AWS_TEST_DIRECTORY_MSAD=1.
test.provider.skipIf(!process.env.AWS_TEST_DIRECTORY_MSAD)(
  "create Microsoft AD directory with conditional forwarder, update DNS, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;
      const directoryProps = {
        type: "MicrosoftAD" as const,
        name: "msad.alchemy-test.internal",
        password: Redacted.make("AlchemyTest123!"),
        edition: "Standard" as const,
        vpcId: network.vpcId,
        subnetIds: network.subnetIds,
      };
      const build = (dnsIpAddrs: string[]) =>
        Effect.gen(function* () {
          const directory = yield* Directory("MsAd", directoryProps);
          const forwarder = yield* ConditionalForwarder("Partner", {
            directoryId: directory.directoryId,
            remoteDomainName: "partner.alchemy-test.internal",
            dnsIpAddrs,
          });
          return { directory, forwarder };
        });

      const { directory, forwarder } = yield* stack.deploy(
        build(["10.200.0.2"]),
      );
      expect(directory.type).toBe("MicrosoftAD");
      expect(directory.stage).toBe("Active");
      expect(forwarder.remoteDomainName).toBe("partner.alchemy-test.internal");
      expect(forwarder.dnsIpAddrs).toEqual(["10.200.0.2"]);

      // Out-of-band verification via distilled.
      const observed = yield* ds.describeConditionalForwarders({
        DirectoryId: directory.directoryId,
        RemoteDomainNames: ["partner.alchemy-test.internal"],
      });
      expect(observed.ConditionalForwarders?.[0]?.DnsIpAddrs).toEqual([
        "10.200.0.2",
      ]);

      // DNS addresses mutate in place — same directory, same forwarder.
      const { forwarder: updated } = yield* stack.deploy(
        build(["10.200.0.2", "10.200.1.2"]),
      );
      expect([...updated.dnsIpAddrs].sort()).toEqual([
        "10.200.0.2",
        "10.200.1.2",
      ]);

      yield* stack.destroy();
      yield* assertDirectoryDeleting(directory.directoryId);
    }),
  // Microsoft AD create (20-40 min) + forwarder sync + delete initiation.
  { timeout: 3_600_000 },
);
