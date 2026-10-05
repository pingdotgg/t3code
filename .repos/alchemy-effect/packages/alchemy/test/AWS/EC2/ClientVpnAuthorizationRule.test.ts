import * as AWS from "@/AWS";
import { ClientVpnAuthorizationRule } from "@/AWS/EC2/ClientVpnAuthorizationRule.ts";
import { ClientVpnEndpoint } from "@/AWS/EC2/ClientVpnEndpoint.ts";
import * as Alchemy from "@/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertClientVpnAuthorizationDeleted,
  assertClientVpnCertificateDeleted,
  clientVpnEndpointProps,
  clientVpnTestTimeout,
  importClientVpnCertificate,
  readClientVpnAuthorizationRules,
  waitForClientVpn,
} from "./fixtures/client-vpn.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});
const certificate = beforeAll(
  importClientVpnCertificate("ClientVpnAuthorizationPrerequisites"),
);
const Stack = Alchemy.Stack(
  "ClientVpnAuthorizationPrerequisites",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const certificateArn = yield* certificate;
    const endpoint = yield* ClientVpnEndpoint(
      "Endpoint",
      clientVpnEndpointProps(certificateArn),
    );
    return { endpoint };
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

test.provider(
  "creates, lists, replaces, and deletes authorization rules without a subnet association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { endpoint } = yield* prerequisites;
      const clientVpnEndpointId = endpoint.clientVpnEndpointId;
      const deployRule = (targetNetworkCidr: string, description?: string) =>
        stack.deploy(
          ClientVpnAuthorizationRule("Authorization", {
            clientVpnEndpointId,
            targetNetworkCidr,
            authorizeAllGroups: true,
            description,
          }),
        );
      const created = yield* deployRule(
        "10.171.0.0/16",
        "Initial authorization",
      );
      expect(created.clientVpnEndpointId).toBe(clientVpnEndpointId);
      expect(created.targetNetworkCidr).toBe("10.171.0.0/16");
      const initial = yield* waitForClientVpn(
        readClientVpnAuthorizationRules(clientVpnEndpointId),
        (rules) =>
          rules.some(
            (rule) =>
              rule.DestinationCidr === "10.171.0.0/16" &&
              rule.Status?.Code === "active",
          ),
        "active authorization",
      );
      expect(initial).toContainEqual(
        expect.objectContaining({
          DestinationCidr: "10.171.0.0/16",
          AccessAll: true,
          Description: "Initial authorization",
        }),
      );
      const provider = yield* Provider.findProvider(ClientVpnAuthorizationRule);
      const listed = yield* waitForClientVpn(
        provider.list(),
        (rules) =>
          rules.some(
            (rule) =>
              rule.clientVpnEndpointId === clientVpnEndpointId &&
              rule.targetNetworkCidr === "10.171.0.0/16",
          ),
        "authorization provider list",
      );
      expect(listed).toContainEqual(
        expect.objectContaining({
          clientVpnEndpointId,
          targetNetworkCidr: "10.171.0.0/16",
          authorizeAllGroups: true,
        }),
      );

      yield* deployRule("10.171.0.0/16", "Initial authorization");
      expect(
        (yield* readClientVpnAuthorizationRules(clientVpnEndpointId)).filter(
          (rule) =>
            rule.DestinationCidr === "10.171.0.0/16" &&
            rule.Status?.Code === "active",
        ),
      ).toHaveLength(1);

      // AWS has no modify-authorization API; a description change must revoke and recreate.
      yield* deployRule("10.171.0.0/16", "Updated authorization");
      const updated = yield* waitForClientVpn(
        readClientVpnAuthorizationRules(clientVpnEndpointId),
        (rules) =>
          rules.some(
            (rule) =>
              rule.DestinationCidr === "10.171.0.0/16" &&
              rule.Description === "Updated authorization" &&
              rule.Status?.Code === "active",
          ),
        "replaced authorization description",
      );
      expect(
        updated.filter(
          (rule) =>
            rule.DestinationCidr === "10.171.0.0/16" &&
            rule.Status?.Code === "active",
        ),
      ).toHaveLength(1);

      const replaced = yield* deployRule("10.172.0.0/16");
      expect(replaced.targetNetworkCidr).toBe("10.172.0.0/16");
      const replacement = yield* waitForClientVpn(
        readClientVpnAuthorizationRules(clientVpnEndpointId),
        (rules) =>
          rules.some(
            (rule) =>
              rule.DestinationCidr === "10.172.0.0/16" &&
              rule.Status?.Code === "active",
          ),
        "replacement authorization CIDR",
      );
      expect(
        replacement.find(
          (rule) =>
            rule.DestinationCidr === "10.172.0.0/16" &&
            rule.Status?.Code === "active",
        )?.Description ?? "",
      ).toBe("");
      yield* assertClientVpnAuthorizationDeleted(
        clientVpnEndpointId,
        "10.171.0.0/16",
      );
      yield* stack.destroy();
      yield* assertClientVpnAuthorizationDeleted(
        clientVpnEndpointId,
        "10.172.0.0/16",
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:acm", "provider:aws:ec2", "live"],
    timeout: clientVpnTestTimeout,
  },
);

test.provider(
  "recreates an authorization rule revoked out of band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { endpoint } = yield* prerequisites;
      const clientVpnEndpointId = endpoint.clientVpnEndpointId;
      const targetNetworkCidr = "10.173.0.0/16";
      const program = ClientVpnAuthorizationRule("Authorization", {
        clientVpnEndpointId,
        targetNetworkCidr,
        authorizeAllGroups: true,
        description: "Managed authorization",
      });
      yield* stack.deploy(program);
      yield* ec2.revokeClientVpnIngress({
        ClientVpnEndpointId: clientVpnEndpointId,
        TargetNetworkCidr: targetNetworkCidr,
        RevokeAllGroups: true,
      });
      yield* assertClientVpnAuthorizationDeleted(
        clientVpnEndpointId,
        targetNetworkCidr,
      );
      yield* stack.deploy(program);
      const repaired = yield* waitForClientVpn(
        readClientVpnAuthorizationRules(clientVpnEndpointId),
        (rules) =>
          rules.some(
            (rule) =>
              rule.DestinationCidr === targetNetworkCidr &&
              rule.Status?.Code === "active",
          ),
        "recreated authorization",
      );
      expect(repaired).toContainEqual(
        expect.objectContaining({
          DestinationCidr: targetNetworkCidr,
          AccessAll: true,
          Description: "Managed authorization",
        }),
      );
      yield* stack.destroy();
      yield* assertClientVpnAuthorizationDeleted(
        clientVpnEndpointId,
        targetNetworkCidr,
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:acm", "provider:aws:ec2", "live"],
    timeout: clientVpnTestTimeout,
  },
);

test.provider(
  "discovers an authorization rule by natural key without prior state and deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { endpoint } = yield* prerequisites;
      const clientVpnEndpointId = endpoint.clientVpnEndpointId;
      const targetNetworkCidr = "10.174.0.0/16";
      const description = "Cold natural-key discovery";
      yield* ec2.authorizeClientVpnIngress({
        ClientVpnEndpointId: clientVpnEndpointId,
        TargetNetworkCidr: targetNetworkCidr,
        AuthorizeAllGroups: true,
        Description: description,
      });
      const preexisting = yield* waitForClientVpn(
        readClientVpnAuthorizationRules(clientVpnEndpointId),
        (rules) =>
          rules.some(
            (rule) =>
              rule.DestinationCidr === targetNetworkCidr &&
              rule.AccessAll === true &&
              rule.Status?.Code === "active",
          ),
        "SDK-created authorization",
      );
      const original = preexisting.filter(
        (rule) =>
          rule.DestinationCidr === targetNetworkCidr && rule.AccessAll === true,
      );
      expect(original).toHaveLength(1);

      const managed = yield* stack.deploy(
        ClientVpnAuthorizationRule("Authorization", {
          clientVpnEndpointId,
          targetNetworkCidr,
          authorizeAllGroups: true,
          description,
        }),
      );
      expect(managed).toMatchObject({
        clientVpnEndpointId,
        targetNetworkCidr,
        authorizeAllGroups: true,
        description,
        status: "active",
      });
      const observed =
        yield* readClientVpnAuthorizationRules(clientVpnEndpointId);
      expect(
        observed.filter(
          (rule) =>
            rule.DestinationCidr === targetNetworkCidr &&
            rule.AccessAll === true,
        ),
      ).toEqual(original);

      yield* stack.destroy();
      yield* assertClientVpnAuthorizationDeleted(
        clientVpnEndpointId,
        targetNetworkCidr,
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:acm", "provider:aws:ec2", "live"],
    timeout: clientVpnTestTimeout,
  },
);
