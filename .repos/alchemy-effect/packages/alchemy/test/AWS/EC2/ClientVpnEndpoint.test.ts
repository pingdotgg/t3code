import * as AWS from "@/AWS";
import { SecurityGroup, Vpc } from "@/AWS/EC2";
import {
  ClientVpnEndpoint,
  type ClientVpnEndpointProps,
} from "@/AWS/EC2/ClientVpnEndpoint.ts";
import { LogGroup, LogStream } from "@/AWS/Logs";
import * as Alchemy from "@/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertClientVpnCertificateDeleted,
  assertClientVpnEndpointDeleted,
  clientVpnEndpointProps,
  clientVpnTestTimeout,
  expectClientVpnOwnershipTags,
  importClientVpnCertificate,
  readClientVpnEndpoint,
  waitForClientVpn,
} from "./fixtures/client-vpn.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});
const certificate = beforeAll(
  importClientVpnCertificate("ClientVpnEndpointPrerequisites"),
);
const Stack = Alchemy.Stack(
  "ClientVpnEndpointPrerequisites",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const certificateArn = yield* certificate;
    const vpc = yield* Vpc("Vpc", { cidrBlock: "10.171.0.0/16" });
    const firstGroup = yield* SecurityGroup("FirstGroup", {
      vpcId: vpc.vpcId,
      description: "Client VPN first security group",
    });
    const secondGroup = yield* SecurityGroup("SecondGroup", {
      vpcId: vpc.vpcId,
      description: "Client VPN second security group",
    });
    const logs = yield* LogGroup("ConnectionLogs", { retention: "1 day" });
    const stream = yield* LogStream("ConnectionLogStream", {
      logGroupName: logs.logGroupName,
    });
    return { certificateArn, vpc, firstGroup, secondGroup, logs, stream };
  }),
);
const prerequisites = beforeAll(deploy(Stack), {
  timeout: clientVpnTestTimeout,
});
afterAll(
  destroy(Stack).pipe(
    Effect.andThen(
      certificate.pipe(Effect.flatMap(assertClientVpnCertificateDeleted)),
    ),
  ),
  { timeout: clientVpnTestTimeout },
);

// Keep replacement generations within the account's Client VPN endpoint quota.
describe.sequential(
  "Client VPN endpoints",
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:aws:ec2",
      "provider:aws:logs",
      "live",
    ],
  },
  () => {
    test.provider(
      "creates, lists, updates, removes optional settings, and deletes a Client VPN endpoint",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const fixture = yield* prerequisites;
          const base = {
            ...clientVpnEndpointProps(fixture.certificateArn),
            vpcId: fixture.vpc.vpcId,
          };
          const deployEndpoint = (props: Partial<ClientVpnEndpointProps>) =>
            stack.deploy(ClientVpnEndpoint("Endpoint", { ...base, ...props }));
          const created = yield* deployEndpoint({
            description: "Client VPN initial description",
            dnsServers: ["1.1.1.1"],
            vpnPort: 443,
            splitTunnel: false,
            connectionLogOptions: { enabled: false },
            securityGroupIds: [fixture.firstGroup.groupId],
            sessionTimeoutHours: 8,
            clientLoginBannerOptions: {
              enabled: true,
              bannerText: "Initial banner",
            },
            clientConnectOptions: { enabled: false },
            selfServicePortal: "disabled",
            tags: { Environment: "initial", RemoveMe: "yes" },
          });
          expect(created.clientVpnEndpointId).toMatch(/^cvpn-endpoint-/);
          expect(created.dnsName).toBeTruthy();
          expect(created.status).toBeDefined();
          const initial = yield* waitForClientVpn(
            readClientVpnEndpoint(created.clientVpnEndpointId),
            (endpoint) => endpoint?.Status?.Code === "pending-associate",
            created.clientVpnEndpointId,
          );
          expect(initial).toMatchObject({
            ClientVpnEndpointId: created.clientVpnEndpointId,
            ClientCidrBlock: base.clientCidrBlock,
            ServerCertificateArn: fixture.certificateArn,
            TransportProtocol: "udp",
            VpnPort: 443,
            SplitTunnel: false,
            VpcId: fixture.vpc.vpcId,
            SecurityGroupIds: [fixture.firstGroup.groupId],
            DnsServers: ["1.1.1.1"],
            SessionTimeoutHours: 8,
            ConnectionLogOptions: { Enabled: false },
            ClientLoginBannerOptions: {
              Enabled: true,
              BannerText: "Initial banner",
            },
            AuthenticationOptions: [
              {
                Type: "certificate-authentication",
                MutualAuthentication: {
                  ClientRootCertificateChain: fixture.certificateArn,
                },
              },
            ],
          });
          expectClientVpnOwnershipTags(initial?.Tags, stack, "Endpoint");
          const provider = yield* Provider.findProvider(ClientVpnEndpoint);
          const listed = yield* waitForClientVpn(
            provider.list(),
            (endpoints) =>
              endpoints.some(
                (endpoint) =>
                  endpoint.clientVpnEndpointId === created.clientVpnEndpointId,
              ),
            "Client VPN endpoint provider list",
          );
          expect(
            listed.find(
              (endpoint) =>
                endpoint.clientVpnEndpointId === created.clientVpnEndpointId,
            ),
          ).toMatchObject({ clientCidrBlock: base.clientCidrBlock });

          const updated = yield* deployEndpoint({
            description: "Client VPN updated description",
            dnsServers: ["8.8.8.8", "8.8.4.4"],
            vpnPort: 1194,
            splitTunnel: true,
            connectionLogOptions: {
              enabled: true,
              cloudwatchLogGroup: fixture.logs.logGroupName,
              cloudwatchLogStream: fixture.stream.logStreamName,
            },
            securityGroupIds: [fixture.secondGroup.groupId],
            sessionTimeoutHours: 10,
            clientLoginBannerOptions: {
              enabled: true,
              bannerText: "Updated banner",
            },
            tags: { Environment: "updated" },
          });
          expect(updated.clientVpnEndpointId).toBe(created.clientVpnEndpointId);
          expect(updated).toMatchObject({
            description: "Client VPN updated description",
            dnsServers: ["8.8.8.8", "8.8.4.4"],
            vpnPort: 1194,
            splitTunnel: true,
            securityGroupIds: [fixture.secondGroup.groupId],
            sessionTimeoutHours: 10,
            connectionLogOptions: {
              enabled: true,
              cloudwatchLogGroup: fixture.logs.logGroupName,
              cloudwatchLogStream: fixture.stream.logStreamName,
            },
            clientLoginBannerOptions: {
              enabled: true,
              bannerText: "Updated banner",
            },
          });
          const observed = yield* waitForClientVpn(
            readClientVpnEndpoint(updated.clientVpnEndpointId),
            (endpoint) =>
              endpoint?.Description === "Client VPN updated description" &&
              endpoint.SessionTimeoutHours === 10 &&
              endpoint.SecurityGroupIds?.includes(
                fixture.secondGroup.groupId,
              ) === true,
            "updated endpoint settings",
          );
          expect(observed).toMatchObject({
            DnsServers: ["8.8.8.8", "8.8.4.4"],
            VpnPort: 1194,
            SplitTunnel: true,
            ConnectionLogOptions: {
              Enabled: true,
              CloudwatchLogGroup: fixture.logs.logGroupName,
              CloudwatchLogStream: fixture.stream.logStreamName,
            },
            ClientLoginBannerOptions: {
              Enabled: true,
              BannerText: "Updated banner",
            },
          });
          expect(observed?.Tags).toContainEqual({
            Key: "Environment",
            Value: "updated",
          });
          expect(observed?.Tags?.some((tag) => tag.Key === "RemoveMe")).toBe(
            false,
          );
          expectClientVpnOwnershipTags(observed?.Tags, stack, "Endpoint");

          const defaults = yield* deployEndpoint({});
          expect(defaults.clientVpnEndpointId).toBe(
            created.clientVpnEndpointId,
          );
          expect(defaults).toMatchObject({
            description: "",
            dnsServers: [],
            vpnPort: 443,
            splitTunnel: false,
            sessionTimeoutHours: 24,
            connectionLogOptions: { enabled: false },
            clientLoginBannerOptions: { enabled: false },
            clientConnectOptions: { enabled: false },
          });
          const reset = yield* waitForClientVpn(
            readClientVpnEndpoint(defaults.clientVpnEndpointId),
            (endpoint) =>
              endpoint !== undefined &&
              !endpoint.Description &&
              (endpoint.DnsServers ?? []).length === 0 &&
              endpoint.SessionTimeoutHours === 24 &&
              endpoint.ClientLoginBannerOptions?.Enabled !== true,
            "endpoint default restoration",
          );
          expect(reset).toMatchObject({
            VpnPort: 443,
            SplitTunnel: false,
            ConnectionLogOptions: { Enabled: false },
          });
          expect(reset?.ClientConnectOptions?.Enabled ?? false).toBe(false);
          expect(reset?.ClientLoginBannerOptions?.Enabled ?? false).toBe(false);
          expect(reset?.Tags?.some((tag) => tag.Key === "Environment")).toBe(
            false,
          );
          const groups = yield* ec2.describeSecurityGroups({
            Filters: [
              { Name: "vpc-id", Values: [fixture.vpc.vpcId] },
              { Name: "group-name", Values: ["default"] },
            ],
          });
          expect(reset?.SecurityGroupIds).toEqual([
            groups.SecurityGroups?.[0]?.GroupId,
          ]);
          expectClientVpnOwnershipTags(reset?.Tags, stack, "Endpoint");
          yield* stack.destroy();
          yield* assertClientVpnEndpointDeleted(created.clientVpnEndpointId);
        }),
      { timeout: clientVpnTestTimeout },
    );

    test.provider(
      "repairs out-of-band endpoint settings and tags with unchanged desired props",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { certificateArn } = yield* prerequisites;
          const props: ClientVpnEndpointProps = {
            ...clientVpnEndpointProps(certificateArn),
            description: "Managed description",
            dnsServers: ["1.1.1.1"],
            splitTunnel: true,
            tags: { Environment: "managed" },
          };
          const program = ClientVpnEndpoint("Endpoint", props);
          const created = yield* stack.deploy(program);
          yield* ec2.modifyClientVpnEndpoint({
            ClientVpnEndpointId: created.clientVpnEndpointId,
            Description: "Out-of-band description",
            DnsServers: { CustomDnsServers: ["8.8.8.8"], Enabled: true },
            SplitTunnel: false,
          });
          yield* ec2.createTags({
            Resources: [created.clientVpnEndpointId],
            Tags: [
              { Key: "Environment", Value: "drifted" },
              { Key: "Unmanaged", Value: "remove" },
            ],
          });
          yield* waitForClientVpn(
            readClientVpnEndpoint(created.clientVpnEndpointId),
            (endpoint) => endpoint?.Description === "Out-of-band description",
            "out-of-band endpoint modification",
          );
          const plan = yield* stack.plan(program);
          expect(plan.resources.Endpoint?.action).toBe("update");
          const repaired = yield* stack.deploy(program);
          expect(repaired.clientVpnEndpointId).toBe(
            created.clientVpnEndpointId,
          );
          const observed = yield* waitForClientVpn(
            readClientVpnEndpoint(created.clientVpnEndpointId),
            (endpoint) => endpoint?.Description === props.description,
            "repaired endpoint",
          );
          expect(observed).toMatchObject({
            DnsServers: ["1.1.1.1"],
            SplitTunnel: true,
          });
          expect(observed?.Tags).toContainEqual({
            Key: "Environment",
            Value: "managed",
          });
          expect(observed?.Tags?.some((tag) => tag.Key === "Unmanaged")).toBe(
            false,
          );
          expectClientVpnOwnershipTags(observed?.Tags, stack, "Endpoint");
          yield* stack.destroy();
          yield* assertClientVpnEndpointDeleted(created.clientVpnEndpointId);
        }),
      { timeout: clientVpnTestTimeout },
    );

    test.provider(
      "enables group-only logging from a newly created dependency without replacing the endpoint",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { certificateArn } = yield* prerequisites;
          const program = (logging: boolean) =>
            Effect.gen(function* () {
              const logs = logging
                ? yield* LogGroup("NewConnectionLogs", { retention: "1 day" })
                : undefined;
              const endpoint = yield* ClientVpnEndpoint("Endpoint", {
                ...clientVpnEndpointProps(certificateArn),
                connectionLogOptions: logs
                  ? { enabled: true, cloudwatchLogGroup: logs.logGroupName }
                  : undefined,
              });
              return { endpoint, logs };
            });
          const created = yield* stack.deploy(program(false));
          const plan = yield* stack.plan(program(true));
          expect(plan.resources.Endpoint?.action).toBe("update");
          expect(plan.resources.NewConnectionLogs?.action).toBe("create");
          const updated = yield* stack.deploy(program(true));
          expect(updated.endpoint.clientVpnEndpointId).toBe(
            created.endpoint.clientVpnEndpointId,
          );
          const observed = yield* readClientVpnEndpoint(
            updated.endpoint.clientVpnEndpointId,
          );
          expect(observed?.ConnectionLogOptions).toMatchObject({
            Enabled: true,
            CloudwatchLogGroup: updated.logs?.logGroupName,
          });
          expect(
            (yield* stack.plan(program(true))).resources.Endpoint?.action,
          ).toBe("noop");
          yield* stack.destroy();
          yield* assertClientVpnEndpointDeleted(
            updated.endpoint.clientVpnEndpointId,
          );
        }),
      { timeout: clientVpnTestTimeout },
    );

    test.provider(
      "fails with a typed error when the configured VPC has been deleted",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { certificateArn } = yield* prerequisites;
          const vpc = yield* stack.deploy(
            Vpc("DeletedVpc", { cidrBlock: "10.175.0.0/16" }),
          );
          yield* stack.destroy();
          const failure = yield* stack
            .deploy(
              ClientVpnEndpoint("Endpoint", {
                ...clientVpnEndpointProps(certificateArn),
                vpcId: vpc.vpcId,
              }),
            )
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "InvalidVpcID.NotFound" });
          yield* stack.destroy();
        }),
      { timeout: clientVpnTestTimeout },
    );

    test.provider(
      "replaces an endpoint for client CIDR and transport protocol changes",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { certificateArn } = yield* prerequisites;
          const deployEndpoint = (
            clientCidrBlock: string,
            transportProtocol: "udp" | "tcp",
          ) =>
            stack.deploy(
              ClientVpnEndpoint("Endpoint", {
                ...clientVpnEndpointProps(certificateArn),
                clientCidrBlock,
                transportProtocol,
              }),
            );
          const created = yield* deployEndpoint("172.20.0.0/22", "udp");
          const changedCidr = yield* deployEndpoint("172.20.4.0/22", "udp");
          expect(changedCidr.clientVpnEndpointId).not.toBe(
            created.clientVpnEndpointId,
          );
          expect(
            yield* readClientVpnEndpoint(changedCidr.clientVpnEndpointId),
          ).toMatchObject({
            ClientCidrBlock: "172.20.4.0/22",
            TransportProtocol: "udp",
          });
          yield* assertClientVpnEndpointDeleted(created.clientVpnEndpointId);
          const changedProtocol = yield* deployEndpoint("172.20.4.0/22", "tcp");
          expect(changedProtocol.clientVpnEndpointId).not.toBe(
            changedCidr.clientVpnEndpointId,
          );
          expect(
            yield* readClientVpnEndpoint(changedProtocol.clientVpnEndpointId),
          ).toMatchObject({
            ClientCidrBlock: "172.20.4.0/22",
            TransportProtocol: "tcp",
          });
          yield* assertClientVpnEndpointDeleted(
            changedCidr.clientVpnEndpointId,
          );
          yield* stack.destroy();
          yield* assertClientVpnEndpointDeleted(
            changedProtocol.clientVpnEndpointId,
          );
        }),
      { timeout: clientVpnTestTimeout },
    );
  },
);
