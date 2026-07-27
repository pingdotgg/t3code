import * as AWS from "@/AWS";
import { Accelerator, EndpointGroup, Listener } from "@/AWS/GlobalAccelerator";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as ga from "@distilled.cloud/aws/global-accelerator";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic (per test case) bucket for accelerator flow logs. Flow-log
// delivery requires a bucket policy granting the log-delivery service
// principal write access.
const FLOW_LOGS_BUCKET = "alchemy-test-ga-flow-logs-4f81c2";

// The testing profile runs in us-west-2, which is exactly where the Global
// Accelerator control plane lives, so out-of-band verification calls the
// distilled ops directly.

const assertAcceleratorGone = (acceleratorArn: string) =>
  ga.describeAccelerator({ AcceleratorArn: acceleratorArn }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`accelerator ${acceleratorArn} still exists`)),
    ),
    Effect.catchTag("AcceleratorNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe.sequential("AWS.GlobalAccelerator", () => {
  test.provider(
    "creates accelerator + listener + endpoint group, updates in place, destroys in order",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = (opts: {
          listenerPorts: { fromPort: number; toPort: number }[];
          clientAffinity?: "NONE" | "SOURCE_IP";
          trafficDial?: number;
          flowLogs?: boolean;
          tags: Record<string, string>;
        }) =>
          Effect.gen(function* () {
            const bucket = yield* Bucket("FlowLogsBucket", {
              bucketName: FLOW_LOGS_BUCKET,
              policy: [
                {
                  Sid: "AWSLogDeliveryWrite",
                  Effect: "Allow",
                  Principal: { Service: "delivery.logs.amazonaws.com" },
                  Action: ["s3:PutObject"],
                  Resource: [`arn:aws:s3:::${FLOW_LOGS_BUCKET}/*`],
                },
                {
                  Sid: "AWSLogDeliveryAclCheck",
                  Effect: "Allow",
                  Principal: { Service: "delivery.logs.amazonaws.com" },
                  Action: ["s3:GetBucketAcl"],
                  Resource: [`arn:aws:s3:::${FLOW_LOGS_BUCKET}`],
                },
              ],
              forceDestroy: true,
            });
            const accelerator = yield* Accelerator("TestAccelerator", {
              flowLogs: opts.flowLogs
                ? { bucket: bucket.bucketName, prefix: "ga-flow-logs" }
                : undefined,
              tags: opts.tags,
            });
            const listener = yield* Listener("WebListener", {
              acceleratorArn: accelerator.acceleratorArn,
              portRanges: opts.listenerPorts,
              protocol: "TCP",
              clientAffinity: opts.clientAffinity,
            });
            const group = yield* EndpointGroup("UsWest2Group", {
              listenerArn: listener.listenerArn,
              endpointGroupRegion: "us-west-2",
              trafficDialPercentage: opts.trafficDial,
              healthCheckProtocol: "TCP",
              healthCheckPort: 80,
            });
            return {
              acceleratorArn: accelerator.acceleratorArn,
              acceleratorName: accelerator.name,
              dnsName: accelerator.dnsName,
              flowLogsEnabled: accelerator.flowLogsEnabled,
              listenerArn: listener.listenerArn,
              endpointGroupArn: group.endpointGroupArn,
              trafficDialPercentage: group.trafficDialPercentage,
            };
          });

        // --- create ---
        const created = yield* stack.deploy(
          program({
            listenerPorts: [{ fromPort: 80, toPort: 80 }],
            tags: { purpose: "alchemy-test" },
          }),
        );
        expect(created.acceleratorArn).toContain(":accelerator/");
        expect(created.dnsName).toBeTruthy();
        expect(created.flowLogsEnabled).toBe(false);
        expect(created.listenerArn).toContain("/listener/");
        expect(created.endpointGroupArn).toContain("/endpoint-group/");

        // Out-of-band verification via distilled.
        const acc = yield* ga.describeAccelerator({
          AcceleratorArn: created.acceleratorArn,
        });
        expect(acc.Accelerator?.Name).toEqual(created.acceleratorName);
        expect(acc.Accelerator?.Enabled).toBe(true);
        expect(acc.Accelerator?.DnsName).toEqual(created.dnsName);

        const lst = yield* ga.describeListener({
          ListenerArn: created.listenerArn,
        });
        expect(lst.Listener?.Protocol).toEqual("TCP");
        expect(lst.Listener?.PortRanges).toEqual([
          { FromPort: 80, ToPort: 80 },
        ]);
        expect(lst.Listener?.ClientAffinity).toEqual("NONE");

        const grp = yield* ga.describeEndpointGroup({
          EndpointGroupArn: created.endpointGroupArn,
        });
        expect(grp.EndpointGroup?.EndpointGroupRegion).toEqual("us-west-2");
        expect(grp.EndpointGroup?.TrafficDialPercentage).toEqual(100);
        expect(grp.EndpointGroup?.HealthCheckPort).toEqual(80);

        const tags = yield* ga.listTagsForResource({
          ResourceArn: created.acceleratorArn,
        });
        const tagMap = Object.fromEntries(
          (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
        );
        expect(tagMap.purpose).toEqual("alchemy-test");
        expect(tagMap["alchemy::id"]).toEqual("TestAccelerator");

        // --- update 1: listener ports + affinity, accelerator tags + flow logs ---
        const updated = yield* stack.deploy(
          program({
            listenerPorts: [
              { fromPort: 80, toPort: 80 },
              { fromPort: 443, toPort: 443 },
            ],
            clientAffinity: "SOURCE_IP",
            flowLogs: true,
            tags: { purpose: "alchemy-test", team: "platform" },
          }),
        );
        // in-place updates — stable ARNs
        expect(updated.acceleratorArn).toEqual(created.acceleratorArn);
        expect(updated.listenerArn).toEqual(created.listenerArn);
        expect(updated.endpointGroupArn).toEqual(created.endpointGroupArn);
        expect(updated.flowLogsEnabled).toBe(true);

        // Out-of-band: flow logs were enabled via updateAcceleratorAttributes.
        const attrs = yield* ga.describeAcceleratorAttributes({
          AcceleratorArn: created.acceleratorArn,
        });
        expect(attrs.AcceleratorAttributes?.FlowLogsEnabled).toBe(true);
        expect(attrs.AcceleratorAttributes?.FlowLogsS3Bucket).toEqual(
          FLOW_LOGS_BUCKET,
        );
        expect(attrs.AcceleratorAttributes?.FlowLogsS3Prefix).toEqual(
          "ga-flow-logs",
        );

        const lst2 = yield* ga.describeListener({
          ListenerArn: created.listenerArn,
        });
        const ports = (lst2.Listener?.PortRanges ?? [])
          .map((r) => r.FromPort)
          .sort((a, b) => (a ?? 0) - (b ?? 0));
        expect(ports).toEqual([80, 443]);
        expect(lst2.Listener?.ClientAffinity).toEqual("SOURCE_IP");

        const tags2 = yield* ga.listTagsForResource({
          ResourceArn: created.acceleratorArn,
        });
        const tagMap2 = Object.fromEntries(
          (tags2.Tags ?? []).map((t) => [t.Key, t.Value]),
        );
        expect(tagMap2.team).toEqual("platform");

        // --- update 2: endpoint group traffic dial + disable flow logs ---
        const dialed = yield* stack.deploy(
          program({
            listenerPorts: [
              { fromPort: 80, toPort: 80 },
              { fromPort: 443, toPort: 443 },
            ],
            clientAffinity: "SOURCE_IP",
            trafficDial: 50,
            tags: { purpose: "alchemy-test", team: "platform" },
          }),
        );
        expect(dialed.endpointGroupArn).toEqual(created.endpointGroupArn);
        expect(dialed.trafficDialPercentage).toEqual(50);
        expect(dialed.flowLogsEnabled).toBe(false);

        const grp2 = yield* ga.describeEndpointGroup({
          EndpointGroupArn: created.endpointGroupArn,
        });
        expect(grp2.EndpointGroup?.TrafficDialPercentage).toEqual(50);

        const attrs2 = yield* ga.describeAcceleratorAttributes({
          AcceleratorArn: created.acceleratorArn,
        });
        expect(attrs2.AcceleratorAttributes?.FlowLogsEnabled).toBe(false);

        // --- destroy: endpoint group -> listener -> disable -> delete ---
        yield* stack.destroy();
        yield* assertAcceleratorGone(created.acceleratorArn);
      }),
    { timeout: 220_000 },
  );
});
