import * as AWS from "@/AWS";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import {
  DeregisterTargets,
  DeregisterTargetsHttp,
  DescribeCapacityReservation,
  DescribeCapacityReservationHttp,
  DescribeTargetHealth,
  DescribeTargetHealthHttp,
  GetTrustStoreCaCertificatesBundle,
  GetTrustStoreCaCertificatesBundleHttp,
  GetTrustStoreRevocationContent,
  GetTrustStoreRevocationContentHttp,
  LoadBalancer,
  ModifyCapacityReservation,
  ModifyCapacityReservationHttp,
  RegisterTargets,
  RegisterTargetsHttp,
  TargetGroup,
  TrustStore,
} from "@/AWS/ELBv2";
import { Bucket } from "@/AWS/S3";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * An RFC1918 IP outside the default VPC's CIDR. RegisterTargets accepts
 * out-of-VPC private addresses when `AvailabilityZone: "all"` is specified —
 * no live target is needed (this TG isn't attached to a listener, so the
 * health state is `unused`).
 */
export const testTargetIp = "192.168.100.10";

/** S3 key of the trust store's CA bundle (uploaded out-of-band by the test). */
export const bundleKey = "ca-bundle.pem";

// A self-signed CA certificate generated once and checked in (never created
// at test time, per the fixture convention). X.509 v3 with basicConstraints
// CA:TRUE + keyCertSign — ELBv2 trust stores reject v1 certs.
export const CA_BUNDLE_PEM = `-----BEGIN CERTIFICATE-----
MIIC2jCCAcKgAwIBAgIJAJyM/Dvd55qtMA0GCSqGSIb3DQEBCwUAMBoxGDAWBgNV
BAMMD2FsY2hlbXktdGVzdC1jYTAeFw0yNjA2MTcwNjA5MDlaFw0zNjA2MTQwNjA5
MDlaMBoxGDAWBgNVBAMMD2FsY2hlbXktdGVzdC1jYTCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBANgo7XPCQMpyecXg2SCj6Tn6R1snlmhSA1vKGQnHoQBS
QA11DMpv+iFRT9s1d3izaGA4GEcxfrXOsmUBkzYIHJIYakCWdr6qcUXs6lS2uhnZ
qcyR0CamDtHTqAxRKEK+QPaISoxyD3BIwQqE0I8yNzV3/6osIE513e+7tp9E+J04
dBhyG5goSwR3ueqs53gQioYVp/fgLKo4MqFcsA3p7anEE9hyeq1Q/lGAXxQwZmXT
3kQli/JjMoF8OfccpA3aBx9Y2aDTCU8HXTscVYmPSHbnTGkTARGBwnag+Jwq5Uni
YvM2OeDUPwvszgpi3JgiblZQhZQAy4/MeNhmE8qgIa8CAwEAAaMjMCEwDwYDVR0T
AQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAJnp
el0xBbL/eQY87evhy0o+ZTHMVCdI9Uc+kDK0XPMi4hc5OfjWNIy8u5/s33kPkNYS
Y5Jhm5KtGtMb9kXioCWjSi0aREA8zijGrXn1jC+0rksMQmJka63bKsJ4TjFaHMcc
m/xt25xX1Ssp/gWr9YX3MzbPhcn57Uu9OTtzf13F6CMv1XtRS1RKFYtkLZrhvzBR
WPdos3xvn3D0Fjd5H5AgVKTkeb2YPhINfN4jyzn3J09teKZpNN/qHTAQewIh2FnO
MeplcuT3eQVUZNTBelvUE7VKHe11AUc8TkvVMS/XOFeN6OHAJtq08EegbTcjwz9Z
lyGGetkNMmdhGRV6AlY=
-----END CERTIFICATE-----
`;

export class ElbBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ElbBindingsFunction",
) {}

/**
 * Shared fleet for the bindings E2E: an unattached `ip` target group (targets
 * register/deregister without a listener) plus an internal ALB for the
 * capacity-reservation bindings. VPC/subnets are resolved only at deploy
 * time — at runtime the resources resolve to references, so the lookups are
 * guarded off inside the deployed Lambda.
 */
export class BindingsFleet extends Context.Service<
  BindingsFleet,
  {
    targetGroup: TargetGroup;
    loadBalancer: LoadBalancer;
    trustStore: TrustStore;
  }
>()("ELBv2BindingsFleet") {}

export const BindingsFleetLive = Layer.effect(
  BindingsFleet,
  Effect.gen(function* () {
    const isDeploy = !globalThis.__ALCHEMY_RUNTIME__;
    const vpcId = isDeploy
      ? yield* ec2
          .describeVpcs({
            Filters: [{ Name: "isDefault", Values: ["true"] }],
          })
          .pipe(
            Effect.map((r) => r.Vpcs?.[0]?.VpcId ?? "vpc-0"),
            // Deploy-time lookup only; a failure here is a fixture defect, not
            // a typed error the Function impl contract can carry.
            Effect.orDie,
          )
      : "vpc-0";
    const subnetIds = isDeploy
      ? yield* ec2
          .describeSubnets({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "default-for-az", Values: ["true"] },
            ],
          })
          .pipe(
            Effect.map((r) =>
              (r.Subnets ?? [])
                .flatMap((s) => (s.SubnetId ? [s.SubnetId as SubnetId] : []))
                .slice(0, 2),
            ),
            Effect.orDie,
          )
      : (["subnet-0", "subnet-1"] as SubnetId[]);

    const targetGroup = yield* TargetGroup("ElbBindingsTg", {
      vpcId,
      port: 80,
      protocol: "HTTP",
      targetType: "ip",
    });
    const loadBalancer = yield* LoadBalancer("ElbBindingsLb", {
      type: "application",
      scheme: "internal",
      subnets: subnetIds,
    });
    // The CA bundle object is uploaded out-of-band by the test between the
    // bucket-only phase-1 deploy and the full fixture deploy (there is no
    // declarative S3 object resource yet).
    const bucket = yield* Bucket("ElbBindingsBundleBucket", {
      forceDestroy: true,
    });
    const trustStore = yield* TrustStore("ElbBindingsTrustStore", {
      caCertificatesBundleS3Bucket: bucket.bucketName,
      caCertificatesBundleS3Key: bundleKey,
    });
    return { targetGroup, loadBalancer, trustStore };
  }),
);

export default ElbBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { targetGroup, loadBalancer, trustStore } = yield* BindingsFleet;

    const registerTargets = yield* RegisterTargets(targetGroup);
    const deregisterTargets = yield* DeregisterTargets(targetGroup);
    const describeTargetHealth = yield* DescribeTargetHealth(targetGroup);
    const describeCapacityReservation =
      yield* DescribeCapacityReservation(loadBalancer);
    const modifyCapacityReservation =
      yield* ModifyCapacityReservation(loadBalancer);
    const getCaCertificatesBundle =
      yield* GetTrustStoreCaCertificatesBundle(trustStore);
    const getRevocationContent =
      yield* GetTrustStoreRevocationContent(trustStore);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/register") {
          const result = yield* registerTargets({
            Targets: [{ Id: testTargetIp, Port: 80, AvailabilityZone: "all" }],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            message:
              result._tag === "Failure" ? String(result.failure) : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/target-health") {
          const result = yield* describeTargetHealth({}).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            targets:
              result._tag === "Success"
                ? (result.success.TargetHealthDescriptions ?? []).map((d) => ({
                    id: d.Target?.Id,
                    state: d.TargetHealth?.State,
                  }))
                : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/deregister") {
          const result = yield* deregisterTargets({
            Targets: [{ Id: testTargetIp, Port: 80, AvailabilityZone: "all" }],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "GET" && pathname === "/capacity") {
          const result = yield* describeCapacityReservation().pipe(
            Effect.result,
          );
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            states:
              result._tag === "Success"
                ? (result.success.CapacityReservationState ?? []).map(
                    (s) => s.State,
                  )
                : undefined,
          });
        }

        // Resets a reservation that was never set — a no-op that proves the
        // write grant end-to-end without reserving billable LCUs.
        if (request.method === "POST" && pathname === "/capacity-reset") {
          const result = yield* modifyCapacityReservation({
            ResetCapacityReservation: true,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "GET" && pathname === "/truststore-bundle") {
          const result = yield* getCaCertificatesBundle().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            // A presigned S3 URL, valid for ten minutes.
            location:
              result._tag === "Success" ? result.success.Location : undefined,
          });
        }

        // Queries a revocation id that was never added — proves the IAM grant
        // and that the miss surfaces as the typed tag, without needing a CRL
        // fixture.
        if (
          request.method === "GET" &&
          pathname === "/truststore-revocation-missing"
        ) {
          const result = yield* getRevocationContent({
            RevocationId: 424242,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
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
        RegisterTargetsHttp,
        DeregisterTargetsHttp,
        DescribeTargetHealthHttp,
        DescribeCapacityReservationHttp,
        ModifyCapacityReservationHttp,
        GetTrustStoreCaCertificatesBundleHttp,
        GetTrustStoreRevocationContentHttp,
        BindingsFleetLive,
      ),
    ),
  ),
);
