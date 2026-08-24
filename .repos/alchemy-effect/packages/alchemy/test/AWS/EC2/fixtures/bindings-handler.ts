import * as AWS from "@/AWS";
import {
  amazonLinux2023,
  AuthorizeSecurityGroupIngress,
  AuthorizeSecurityGroupIngressHttp,
  consumeInstanceStateEvents,
  CreateSnapshot,
  CreateSnapshotHttp,
  DescribeInstance,
  DescribeInstanceHttp,
  DescribeInstanceStatus,
  DescribeInstanceStatusHttp,
  GetConsoleOutput,
  GetConsoleOutputHttp,
  GetPasswordData,
  GetPasswordDataHttp,
  Instance,
  RebootInstance,
  RebootInstanceHttp,
  RevokeSecurityGroupIngress,
  RevokeSecurityGroupIngressHttp,
  SecurityGroup,
  StartInstance,
  StartInstanceHttp,
  StopInstance,
  StopInstanceHttp,
  Subnet,
  Volume,
  Vpc,
} from "@/AWS/EC2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** The dynamic-allowlisting rule the authorize/revoke routes add and remove. */
export const testIngressRule = {
  IpProtocol: "tcp",
  FromPort: 443,
  ToPort: 443,
  CidrIp: "203.0.113.0/24",
} as const;

export class Ec2BindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "Ec2BindingsFunction",
) {}

/**
 * Shared fleet for the bindings E2E: a dedicated VPC/subnet (the testing
 * account has no default VPC), a t3.micro instance, a 1 GiB volume, and an
 * empty security group. The AMI is resolved only at deploy time — at runtime
 * the resources resolve to references, so the lookup is guarded off inside
 * the deployed Lambda.
 */
export class BindingsFleet extends Context.Service<
  BindingsFleet,
  { instance: Instance; group: SecurityGroup; volume: Volume }
>()("Ec2BindingsFleet") {}

export const BindingsFleetLive = Layer.effect(
  BindingsFleet,
  Effect.gen(function* () {
    const isDeploy = !globalThis.__ALCHEMY_RUNTIME__;
    const imageId = isDeploy
      ? ((yield* amazonLinux2023()) ?? "ami-00000000000000000")
      : "ami-00000000000000000";

    const vpc = yield* Vpc("BindingsVpc", { cidrBlock: "10.61.0.0/16" });
    const subnet = yield* Subnet("BindingsSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.61.1.0/24",
    });
    const group = yield* SecurityGroup("BindingsSecurityGroup", {
      vpcId: vpc.vpcId,
      description: "EC2 bindings test group",
    });
    const volume = yield* Volume("BindingsVolume", {
      availabilityZone: subnet.availabilityZone,
      size: 1,
    });
    const instance = yield* Instance("BindingsInstance", {
      imageId,
      instanceType: "t3.micro",
      subnetId: subnet.subnetId,
    });
    return { instance, group, volume };
  }),
);

export default Ec2BindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { instance, group, volume } = yield* BindingsFleet;

    const describeInstance = yield* DescribeInstance(instance);
    const describeStatus = yield* DescribeInstanceStatus(instance);
    const startInstance = yield* StartInstance(instance);
    const stopInstance = yield* StopInstance(instance);
    const rebootInstance = yield* RebootInstance(instance);
    const getConsoleOutput = yield* GetConsoleOutput(instance);
    const getPasswordData = yield* GetPasswordData(instance);
    const createSnapshot = yield* CreateSnapshot(volume);
    const authorizeIngress = yield* AuthorizeSecurityGroupIngress(group);
    const revokeIngress = yield* RevokeSecurityGroupIngress(group);

    // Subscribe to instance stop/terminate transitions (creates the
    // EventBridge rule at deploy time).
    yield* consumeInstanceStateEvents(
      instance,
      { states: ["stopped", "terminated"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `${event.detail["instance-id"]} is now ${event.detail.state}`,
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const result = yield* describeInstance().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            state:
              result._tag === "Success"
                ? result.success?.State?.Name
                : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/status") {
          const result = yield* describeStatus({
            IncludeAllInstances: true,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            count:
              result._tag === "Success"
                ? (result.success.InstanceStatuses ?? []).length
                : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/console") {
          const result = yield* getConsoleOutput().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // The instance runs Linux without a key pair, so the password data is
        // empty — the probe proves the IAM grant and that a present
        // `PasswordData` surfaces as Redacted (never a raw string).
        if (request.method === "GET" && pathname === "/password") {
          const result = yield* getPasswordData().pipe(Effect.result);
          const passwordData =
            result._tag === "Success" ? result.success.PasswordData : undefined;
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            hasField: passwordData !== undefined,
            redacted:
              passwordData !== undefined
                ? Redacted.isRedacted(passwordData)
                : null,
          });
        }

        // Starting an already-running instance succeeds without effect.
        if (request.method === "POST" && pathname === "/start") {
          const result = yield* startInstance().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "POST" && pathname === "/reboot") {
          const result = yield* rebootInstance().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // Runs LAST in the test file — the instance stays stopped until the
        // stack is destroyed.
        if (request.method === "POST" && pathname === "/stop") {
          const result = yield* stopInstance().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            state:
              result._tag === "Success"
                ? result.success.StoppingInstances?.[0]?.CurrentState?.Name
                : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/authorize") {
          const result = yield* authorizeIngress({
            IpPermissions: [
              {
                IpProtocol: testIngressRule.IpProtocol,
                FromPort: testIngressRule.FromPort,
                ToPort: testIngressRule.ToPort,
                IpRanges: [{ CidrIp: testIngressRule.CidrIp }],
              },
            ],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "POST" && pathname === "/revoke") {
          const result = yield* revokeIngress({
            IpPermissions: [
              {
                IpProtocol: testIngressRule.IpProtocol,
                FromPort: testIngressRule.FromPort,
                ToPort: testIngressRule.ToPort,
                IpRanges: [{ CidrIp: testIngressRule.CidrIp }],
              },
            ],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // Creates a real (1 GiB) snapshot; the test deletes it out-of-band.
        if (request.method === "POST" && pathname === "/snapshot") {
          const result = yield* createSnapshot({
            Description: "alchemy EC2 bindings test snapshot",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            snapshotId:
              result._tag === "Success" ? result.success.SnapshotId : undefined,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.EventSource,
        DescribeInstanceHttp,
        DescribeInstanceStatusHttp,
        StartInstanceHttp,
        StopInstanceHttp,
        RebootInstanceHttp,
        GetConsoleOutputHttp,
        GetPasswordDataHttp,
        CreateSnapshotHttp,
        AuthorizeSecurityGroupIngressHttp,
        RevokeSecurityGroupIngressHttp,
        BindingsFleetLive,
      ),
    ),
  ),
);
