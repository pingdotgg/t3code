import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
import { Listener, LoadBalancer, TargetGroup } from "@/AWS/ELBv2";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import { deleteCertBestEffort, ensureImportedCert } from "./fixtures/acm.ts";
import { OIDC_CERT_PEM, OIDC_KEY_PEM } from "./fixtures/certs.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Exercises the full DefaultActions surface on a single ALB listener:
// forward -> redirect -> fixedResponse -> weighted multi-target-group forward
// with stickiness, all in-place via modifyListener. The network is stack-owned
// so concurrent suites cannot replace the account's default VPC underneath it.
test.provider(
  "listener default actions: forward -> redirect -> fixedResponse -> weighted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const azs =
        azResult.AvailabilityZones?.filter(
          (az) => az.State === "available",
        ).flatMap((az) => (az.ZoneName ? [az.ZoneName] : [])) ?? [];
      const [az1, az2] = azs;
      expect(az1).toBeTruthy();
      expect(az2).toBeTruthy();

      // STAGE 1: simple forward listener (sugar form).
      const s1 = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("LVpc", { cidrBlock: "10.240.0.0/16" });
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.224.0/24",
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.225.0/24",
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          const tgBlue = yield* TargetGroup("LTgBlue", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const tgGreen = yield* TargetGroup("LTgGreen", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const listener = yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            targetGroupArn: tgBlue.targetGroupArn,
            port: 80,
            protocol: "HTTP",
          });
          return {
            listenerArn: listener.listenerArn,
            blue: tgBlue.targetGroupArn,
            green: tgGreen.targetGroupArn,
            lb: lb.loadBalancerArn,
            s1: subnet1.subnetId,
            s2: subnet2.subnetId,
          };
        }),
      );

      const listenerArn = s1.listenerArn;
      const describe = elbv2
        .describeListeners({ ListenerArns: [listenerArn] })
        .pipe(Effect.map((r) => r.Listeners?.[0]));

      let observed = yield* describe;
      expect(observed?.DefaultActions?.[0]?.Type).toBe("forward");

      // STAGE 2: redirect HTTP -> HTTPS (in place).
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("LVpc", { cidrBlock: "10.240.0.0/16" });
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.224.0/24",
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.225.0/24",
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          yield* TargetGroup("LTgBlue", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* TargetGroup("LTgGreen", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "redirect",
                statusCode: "HTTP_301",
                protocol: "HTTPS",
                port: "443",
              },
            ],
          });
        }),
      );

      observed = yield* describe;
      expect(observed?.DefaultActions?.[0]?.Type).toBe("redirect");
      expect(observed?.DefaultActions?.[0]?.RedirectConfig?.StatusCode).toBe(
        "HTTP_301",
      );

      // STAGE 3: fixed-response (in place).
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("LVpc", { cidrBlock: "10.240.0.0/16" });
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.224.0/24",
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.225.0/24",
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          yield* TargetGroup("LTgBlue", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* TargetGroup("LTgGreen", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "fixedResponse",
                statusCode: "503",
                contentType: "text/plain",
                messageBody: "down",
              },
            ],
          });
        }),
      );

      observed = yield* describe;
      expect(observed?.DefaultActions?.[0]?.Type).toBe("fixed-response");
      expect(
        observed?.DefaultActions?.[0]?.FixedResponseConfig?.StatusCode,
      ).toBe("503");

      // STAGE 4: weighted multi-target-group forward with stickiness.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("LVpc", { cidrBlock: "10.240.0.0/16" });
          const subnet1 = yield* Subnet("LSubnet1", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.224.0/24",
            availabilityZone: az1,
          });
          const subnet2 = yield* Subnet("LSubnet2", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.240.225.0/24",
            availabilityZone: az2,
          });
          const lb = yield* LoadBalancer("LLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });
          const tgBlue = yield* TargetGroup("LTgBlue", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          const tgGreen = yield* TargetGroup("LTgGreen", {
            vpcId: vpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });
          yield* Listener("LListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "forward",
                targetGroups: [
                  { targetGroupArn: tgBlue.targetGroupArn, weight: 90 },
                  { targetGroupArn: tgGreen.targetGroupArn, weight: 10 },
                ],
                stickiness: { enabled: true, duration: "1 hour" },
              },
            ],
          });
        }),
      );

      observed = yield* describe;
      const forward = observed?.DefaultActions?.find(
        (x) => x.Type === "forward",
      );
      expect(forward?.ForwardConfig?.TargetGroups?.length).toBe(2);
      const weights = (forward?.ForwardConfig?.TargetGroups ?? [])
        .map((t) => t.Weight)
        .sort();
      expect(weights).toEqual([10, 90]);
      expect(forward?.ForwardConfig?.TargetGroupStickinessConfig?.Enabled).toBe(
        true,
      );
      // Duration.Input "1 hour" must reach the wire as whole seconds.
      expect(
        forward?.ForwardConfig?.TargetGroupStickinessConfig?.DurationSeconds,
      ).toBe(3600);

      yield* stack.destroy();

      // Verify the listener is gone.
      const after = yield* elbv2
        .describeListeners({ ListenerArns: [listenerArn] })
        .pipe(
          Effect.map((r) => r.Listeners?.length ?? 0),
          Effect.catchTag("ListenerNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);

// Live-verifies the audited prop conversions on the authenticate-oidc action:
// `clientSecret` is a Redacted<string> (unwrapped to the plain secret on the
// wire — AWS rejects a non-string) and `sessionTimeout` is a Duration.Input
// serialized as whole seconds. ELBv2 stores the OIDC endpoints without calling
// the IdP at configure time, so dummy HTTPS endpoints are sufficient.
test.provider(
  "authenticate-oidc action: Redacted clientSecret + Duration sessionTimeout",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const certArn = yield* ensureImportedCert(
        "oidc.elbv2-test.alchemy.internal",
        OIDC_CERT_PEM,
        OIDC_KEY_PEM,
      );

      // Everything below runs under an `Effect.ensuring` finalizer so the
      // out-of-band certificate is deleted even when the body fails mid-test
      // (on success this runs after stack.destroy, so the cert is detached
      // and deletes cleanly; a still-attached cert on a failure path is left
      // behind and reclaimed by the next run's ensureImportedCert).
      yield* Effect.gen(function* () {
        const azResult = yield* EC2.describeAvailabilityZones({});
        const azs =
          azResult.AvailabilityZones?.filter(
            (az) => az.State === "available",
          ).flatMap((az) => (az.ZoneName ? [az.ZoneName] : [])) ?? [];
        const [az1, az2] = azs;
        expect(az1).toBeTruthy();
        expect(az2).toBeTruthy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("OidcVpc", {
              cidrBlock: "10.241.0.0/16",
            });
            const subnet1 = yield* Subnet("OidcSubnet1", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.241.226.0/24",
              availabilityZone: az1,
            });
            const subnet2 = yield* Subnet("OidcSubnet2", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.241.227.0/24",
              availabilityZone: az2,
            });
            const lb = yield* LoadBalancer("OidcLb", {
              subnets: [subnet1.subnetId, subnet2.subnetId],
              scheme: "internal",
              type: "application",
            });
            const listener = yield* Listener("OidcListener", {
              loadBalancerArn: lb.loadBalancerArn,
              port: 443,
              protocol: "HTTPS",
              certificateArn: certArn,
              defaultActions: [
                {
                  type: "authenticateOidc",
                  issuer: "https://idp.elbv2-test.alchemy.internal",
                  authorizationEndpoint:
                    "https://idp.elbv2-test.alchemy.internal/authorize",
                  tokenEndpoint:
                    "https://idp.elbv2-test.alchemy.internal/token",
                  userInfoEndpoint:
                    "https://idp.elbv2-test.alchemy.internal/userinfo",
                  clientId: "alchemy-test-client",
                  clientSecret: Redacted.make("alchemy-test-client-secret"),
                  sessionTimeout: "7 days",
                  onUnauthenticatedRequest: "deny",
                },
                {
                  type: "fixedResponse",
                  statusCode: "200",
                  contentType: "text/plain",
                  messageBody: "authenticated",
                },
              ],
            });
            return { listenerArn: listener.listenerArn };
          }),
        );

        const observed = yield* elbv2
          .describeListeners({ ListenerArns: [deployed.listenerArn] })
          .pipe(Effect.map((r) => r.Listeners?.[0]));

        const oidc = observed?.DefaultActions?.find(
          (a) => a.Type === "authenticate-oidc",
        );
        // The create succeeding proves the Redacted secret was unwrapped to the
        // plain string on the wire (AWS validates ClientSecret is present).
        // Describe never echoes the secret back.
        expect(oidc?.AuthenticateOidcConfig?.ClientId).toBe(
          "alchemy-test-client",
        );
        // Duration.Input "7 days" must reach the wire as whole seconds.
        expect(oidc?.AuthenticateOidcConfig?.SessionTimeout).toBe(604800);
        expect(oidc?.AuthenticateOidcConfig?.OnUnauthenticatedRequest).toBe(
          "deny",
        );

        yield* stack.destroy();
      }).pipe(
        // Guaranteed cleanup of the out-of-band imported certificate.
        Effect.ensuring(deleteCertBestEffort(certArn)),
      );
    }).pipe(logLevel),
  { timeout: 600_000 },
);
