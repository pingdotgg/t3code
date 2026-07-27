import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import { HostedZone } from "@/AWS/Route53";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/aws/acm";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const ZONE_NAME = "alchemy-ecs-domain-test.example";
const DOMAIN = `svc.${ZONE_NAME}`;

// Self-signed certificate for `svc.alchemy-ecs-domain-test.example`,
// generated once with
// `openssl req -x509 -newkey rsa:2048 -days 3650 -nodes -subj "/CN=..."`
// and checked in (fixtures are never generated at test time). ALB listeners
// accept any imported ACM certificate — no CA validation.
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIC2DCCAcACCQDk7zeaJumy7TANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDDCNz
dmMuYWxjaGVteS1lY3MtZG9tYWluLXRlc3QuZXhhbXBsZTAeFw0yNjA3MTgwOTI3
MzZaFw0zNjA3MTUwOTI3MzZaMC4xLDAqBgNVBAMMI3N2Yy5hbGNoZW15LWVjcy1k
b21haW4tdGVzdC5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEApCFJJ3VI2ZhjXi4KlmvwJYcctR+0bXQEh9uWrmMLYexYA03pdDSHPU/j1E4A
2G8KtQZC325Psz+8tHfdcOPSlzVBiCuEp7TypQ9FfeJTYNDkYBY94FjdrPx8nX8z
YYXwv5y4aGUdRNJB+qSaGSAOK0Fc/m+qWCENLmRTRrcC3040NLMJedScT48KvUcp
fjyjSL9wlB09pInWHuNgx3pSaLa+QptV6Y5NJEXyfna7yjo4rYJsvqZcY2iTldiH
3FiUWeXTdw+TjSppS8OZZqB6UJXitBPnyuSI/yr8aJCxLQ2I+pZbT+vG9fJ0UdZV
IvdBKN3im4WFLri/nlspxR86qwIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQB9VVjs
N2ZgdN9PpnSbiyhk/HaaoeAKNsxtzHvPT5YqgIu80Yc1hV6xYhCPnGXDQxB6Ilms
Ul8JoGkyiX0zq2DhYtzdmtUwfFQsZGJb7BmDjqee5aNthTKdEABEIMuclncLSfIz
Y63/MjXMchvisRunRQomxUiGUP5nre2iEgRLYEPA0C/2QY5fHmI0RUNMhL+RqdYv
3bieRGv0Ssg1AOImDEb14/+YM2RQo5cZTOcHC4eT5VgAbCQnhD0zxx2vERmEMwB0
3G7cRrmUnfw9fLz0ta4qaGp4/gJDGa4eNR/BNBuN7T1z+oxquadYvNDH2BzNqNq/
eM6uU4Wgh9A+ctDm
-----END CERTIFICATE-----`;

const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCkIUkndUjZmGNe
LgqWa/Alhxy1H7RtdASH25auYwth7FgDTel0NIc9T+PUTgDYbwq1BkLfbk+zP7y0
d91w49KXNUGIK4SntPKlD0V94lNg0ORgFj3gWN2s/HydfzNhhfC/nLhoZR1E0kH6
pJoZIA4rQVz+b6pYIQ0uZFNGtwLfTjQ0swl51JxPjwq9Ryl+PKNIv3CUHT2kidYe
42DHelJotr5Cm1Xpjk0kRfJ+drvKOjitgmy+plxjaJOV2IfcWJRZ5dN3D5ONKmlL
w5lmoHpQleK0E+fK5Ij/KvxokLEtDYj6lltP68b18nRR1lUi90Eo3eKbhYUuuL+e
WynFHzqrAgMBAAECggEBAJ3slSoNVPpiAYK2RGO2GgzR85JnnkEOt+lNJbBIBsTD
F3Cef/nbLSGWhD5ci721IpVKIABCcRelRVpUV1LvM0tg59wxG2QO3MZrak8U/WsT
tBqsa/85Ipr3GqSkpvi4WwzTrDBu0nnM4cVcqhVw3ZFLREJhiYNg0gEIcYSCRZY8
a2OptUq+lEd5Uk9aODpTnQiZ7keE7XFQwnu0XfsW03pRfHu5Tr9mL5NI+sNc010y
hwdLOOC9eqKrjFc4y16mCb/WAJRdYvUo4+Vnyi66dlojwKRGYIpyaM8wAXQ7fN39
KsMQS0acK0ns7FPDpGrhxpX0WAy/I5lGRUIpgmVzm6ECgYEA1sRAL3vmrRCzfaNk
VzOjKRx10bOvQ73+534J2LlZsKnTp6ma2SzJSKCI8PDJ0TluZb+CIfOlwSnYk1F3
2MjpCNbMnb49QeQX+kztqjHAuLlyI/w/p+3Cfa8agvGim6O9Epn2lGjLG4hgSbr6
K37HUOAlragBziaWXJwoK3YNeLECgYEAw6RBAso61Dx31G9s9ECnZ5IUlMx3njtV
I1RPFtUnkUl+PxJpbrEpyIbWcJjDnoHZTiVlBDURhYRfrKihlGbmu1b+uQXlGQmo
HkFQe1x2JrLWpfdObCr8YaO/W/hO+vvsXA2wQP2D1xTblbe5K+RxeOfpl8vTgsYV
bRIgVTHLgBsCgYEAzJnsWBBew3OMu93EQvsTrp/Jcr0O9Kd1x04gzVJPKumvlSQU
PF/ZZpJhw8BxVBy1msNmkzfOKobWKArN9T36HAyepIzPSQ2m9jMBnEmHw7QQFE5E
ypPM3PXLeQIAmuvTvXvmGJ75GELFEJjLqlI+SkMwQg8zoRTL3HB8KGNwFBECgYEA
sLfnuVtutFNCcnOL2T2leVpsmNPwoM87YkQ/hIJZ0VSvYs2Ayungsi+J9/8lhEIK
RhplGt3My+v8d/uCqIgilspIIF0AyhL89wdMaYHlf6M/XH79KZvSiWfd7Hdo8DEr
GSOMN8hHlLpUdvKTouAg13O0ftcwYQoIRJOA/TOTfE0CgYB+uvQKgrjoRrlKbAb9
qU/xBytHvLHI/WtcrQRz7ZXUHxML5F1M3v2LWdAVnEKGrqfEGTIa+OqTQq1vMHlj
y8xY8yCojeFN5c5xdhHUzOtg4OSFMJxfmet6ObnhYDfc/T2bqwyyPDvrIskGTl1k
qquR06mkJP9PmFqXnf9SpyM2qg==
-----END PRIVATE KEY-----`;

// `domain` with an explicit `cert:` — the composed HTTPS listener carries
// the certificate and alias A/AAAA records land in the (test-created,
// undelegated) hosted zone; `url` prefers the domain. The zone is deployed
// FIRST (the zone lookup runs at composition time), then the service.
// Everything is describe-level except the deploy itself: the zone is not
// publicly delegated, so the domain never resolves on the open internet.
//
// Requires a local Docker daemon (the `image:` source mirrors into ECR).
test.provider.skipIf(!!process.env.FAST)(
  "domain with explicit cert wires the HTTPS listener + alias records; url prefers the domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;

      // Import the self-signed certificate out of band (deleted on the way
      // out); ALB HTTPS listeners require an in-region ACM certificate.
      const imported = yield* acm.importCertificate({
        Certificate: new TextEncoder().encode(CERT_PEM),
        PrivateKey: new TextEncoder().encode(KEY_PEM),
      });
      const certificateArn = imported.CertificateArn!;
      yield* Effect.addFinalizer(() =>
        acm.deleteCertificate({ CertificateArn: certificateArn }).pipe(
          Effect.retry({
            while: (e) => e._tag === "ResourceInUseException",
            schedule: Schedule.max([
              Schedule.spaced("5 seconds"),
              Schedule.recurs(24),
            ]),
          }),
          Effect.ignore,
        ),
      );

      const azSubnets = yield* ec2
        .describeSubnets({
          Filters: [
            { Name: "vpc-id", Values: [net.vpcId] },
            { Name: "default-for-az", Values: ["true"] },
          ],
        })
        .pipe(
          Effect.map((r) =>
            (r.Subnets ?? []).flatMap((s) => (s.SubnetId ? [s.SubnetId] : [])),
          ),
        );

      const program = (includeService: boolean) =>
        Effect.gen(function* () {
          const zone = yield* HostedZone("DomainZone", { name: ZONE_NAME });
          if (!includeService) {
            return { zoneId: zone.id.as<string>() };
          }
          const cluster = yield* Cluster("DomainCluster", {
            clusterName: "alchemy-test-ecs-domain",
          });
          const service = yield* Service("DomainSvc", {
            cluster,
            image: "busybox:stable",
            command: ["sh", "-c", "while true; do sleep 30; done"],
            port: 80,
            desiredCount: 0,
            vpcId: net.vpcId as string,
            subnets: azSubnets,
            loadBalancer: {
              domain: { name: DOMAIN, cert: certificateArn },
            },
          });
          return {
            zoneId: zone.id.as<string>(),
            url: service.url.as<string>(),
            loadBalancerArn: service.loadBalancerArn.as<string>(),
            listenerArn: service.listenerArn.as<string>(),
          };
        });

      // Deploy the zone FIRST: the service's zone lookup runs at
      // composition time, so the zone must exist before the service does.
      yield* stack.deploy(program(false));
      const deployed = (yield* stack.deploy(program(true))) as {
        zoneId: string;
        url: string;
        loadBalancerArn: string;
        listenerArn: string;
      };

      // `url` prefers the domain (https on the default 443 → no port).
      expect(deployed.url).toBe(`https://${DOMAIN}`);

      // The default listener is 443/HTTPS carrying the explicit cert.
      const listeners = yield* elbv2.describeListeners({
        LoadBalancerArn: deployed.loadBalancerArn,
      });
      const httpsListener = (listeners.Listeners ?? []).find(
        (l) => l.Port === 443,
      );
      expect(httpsListener?.Protocol).toBe("HTTPS");
      expect(
        (httpsListener?.Certificates ?? []).some(
          (c) => c.CertificateArn === certificateArn,
        ),
      ).toBe(true);

      // Alias A + AAAA records for the domain point at the ALB.
      const zoneId = deployed.zoneId.replace(/^\/hostedzone\//, "");
      const loadBalancers = yield* elbv2.describeLoadBalancers({
        LoadBalancerArns: [deployed.loadBalancerArn],
      });
      const albDns = loadBalancers.LoadBalancers?.[0]?.DNSName ?? "";
      const records = yield* route53.listResourceRecordSets({
        HostedZoneId: zoneId,
      });
      const aliasRecords = (records.ResourceRecordSets ?? []).filter(
        (record) => record.Name === `${DOMAIN}.` && record.AliasTarget,
      );
      expect(aliasRecords.map((r) => r.Type).sort()).toEqual(["A", "AAAA"]);
      for (const record of aliasRecords) {
        expect(
          record
            .AliasTarget!.DNSName!.toLowerCase()
            .includes(albDns.toLowerCase()),
        ).toBe(true);
      }

      // ── destroy + zero-orphan proofs ──────────────────────────────────
      yield* stack.destroy();

      const lbGone = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancerArn],
        })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(lbGone).toBe(true);

      // The zone (and with it the alias records) is destroyed by the stack.
      const zoneGone = yield* route53.getHostedZone({ Id: zoneId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(true)),
      );
      expect(zoneGone).toBe(true);
    }),
  { timeout: 900_000 },
);

// Typed probe (cheap, no infra): a `domain` whose hosted zone doesn't exist
// fails the deploy with ServiceHostedZoneNotFound before composing anything.
test.provider(
  "domain without a matching hosted zone fails with ServiceHostedZoneNotFound",
  (stack) =>
    Effect.gen(function* () {
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Service("ZonelessSvc", {
              cluster:
                "arn:aws:ecs:us-east-1:123456789012:cluster/never-created" as any,
              image: "busybox:stable",
              port: 80,
              desiredCount: 0,
              loadBalancer: {
                domain: "svc.alchemy-nonexistent-zone-84721.example",
              },
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      const rendered = Result.isFailure(result)
        ? `${JSON.stringify(result.failure)} ${String(result.failure)}`
        : "";
      expect(rendered).toContain("no public Route 53 hosted zone");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

// Full ACM-issuance e2e (composed DNS-validated certificate) needs a REAL
// delegated public zone so validation records resolve — gated behind
// AWS_TEST_DOMAIN=<zone-name> (e.g. an account with `example.com` delegated
// runs `AWS_TEST_DOMAIN=example.com`). Issuance takes minutes.
test.provider.skipIf(!process.env.AWS_TEST_DOMAIN)(
  "domain composes a DNS-validated ACM certificate in a delegated zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneName = process.env.AWS_TEST_DOMAIN!;
      const domainName = `alchemy-ecs-e2e.${zoneName}`;
      const net = yield* getDefaultVpcNetwork;
      const azSubnets = yield* ec2
        .describeSubnets({
          Filters: [
            { Name: "vpc-id", Values: [net.vpcId] },
            { Name: "default-for-az", Values: ["true"] },
          ],
        })
        .pipe(
          Effect.map((r) =>
            (r.Subnets ?? []).flatMap((s) => (s.SubnetId ? [s.SubnetId] : [])),
          ),
        );

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AcmDomainCluster", {
            clusterName: "alchemy-test-ecs-acm-domain",
          });
          const service = yield* Service("AcmDomainSvc", {
            cluster,
            image: "busybox:stable",
            command: ["sh", "-c", "while true; do sleep 30; done"],
            port: 80,
            desiredCount: 0,
            vpcId: net.vpcId as string,
            subnets: azSubnets,
            loadBalancer: { domain: domainName },
          });
          return {
            url: service.url.as<string>(),
            listenerArn: service.listenerArn.as<string>(),
            loadBalancerArn: service.loadBalancerArn.as<string>(),
          };
        }),
      );

      expect(deployed.url).toBe(`https://${domainName}`);
      const listeners = yield* elbv2.describeListeners({
        LoadBalancerArn: deployed.loadBalancerArn,
      });
      const httpsListener = (listeners.Listeners ?? []).find(
        (l) => l.Port === 443,
      );
      expect(httpsListener?.Protocol).toBe("HTTPS");
      expect((httpsListener?.Certificates ?? []).length).toBeGreaterThan(0);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
